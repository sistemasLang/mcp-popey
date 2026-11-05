import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AuthMiddleware } from '../../src/auth/auth.middleware.js';
import { generateToken, hashToken, TokenVerifier } from '../../src/auth/token-verifier.js';
import type { UserContext } from '../../src/auth/user-context.js';
import { CircuitPolicyService } from '../../src/circuits/circuit-policy.service.js';
import {
  AuthenticationError,
  AuthorizationError,
  CircuitNotFoundError,
  ConfigurationError,
  TableNotAllowedError,
} from '../../src/errors/app-errors.js';
import { AuthorizationService } from '../../src/permissions/authorization.service.js';
import { RolePolicyLoader } from '../../src/permissions/role-policy.loader.js';
import { InMemoryUserRepository } from '../../src/users/user.repository.js';
import { loadTestRegistry } from '../helpers.js';

const registry = loadTestRegistry();
const policy = RolePolicyLoader.parse(
  `
roles:
  ventas:
    circuits: [venta, envio_comprobantes]
  compras:
    circuits: [compras, review_cases]
  auditor:
    circuits: [usuario]
`,
  registry,
);
const authorization = new AuthorizationService(policy, registry);
const circuits = new CircuitPolicyService(registry, authorization);

const ventas: UserContext = { userId: '1', role: 'ventas', databaseKey: 'a' };
const compras: UserContext = { userId: '2', role: 'compras', databaseKey: 'a' };
const auditor: UserContext = { userId: '3', role: 'auditor', databaseKey: 'a' };
const nobody: UserContext = { userId: '4', role: 'sin_rol', databaseKey: 'a' };

describe('RolePolicyLoader', () => {
  it('refuses a role that references a circuit not in circuits.yaml', () => {
    expect(() => RolePolicyLoader.parse('roles:\n  x:\n    circuits: [ventas_typo]\n', registry)).toThrow(
      ConfigurationError,
    );
  });

  it('accepts the shipped empty policy', () => {
    expect(RolePolicyLoader.parse('roles: {}\n', registry).roles.size).toBe(0);
  });

  it('sql is opt-in per role: absent means no query_sql', () => {
    const parsed = RolePolicyLoader.parse('roles:\n  a:\n    circuits: [venta]\n  b:\n    circuits: [venta]\n    sql: true\n', registry);
    expect(parsed.canUseSql('a')).toBe(false);
    expect(parsed.canUseSql('b')).toBe(true);
    expect(parsed.canUseSql('unknown')).toBe(false);
    expect([...parsed.sqlRoles]).toEqual(['b']);
  });

  it('sql: true does not grant any circuit by itself', () => {
    const parsed = RolePolicyLoader.parse('roles:\n  analista:\n    sql: true\n', registry);
    expect(parsed.canUseSql('analista')).toBe(true);
    expect(new AuthorizationService(parsed, registry).canAccessCircuit({ userId: 'x', role: 'analista', databaseKey: 'a' }, 'venta')).toBe(false);
  });

  it('the shipped example loads and enables sql only for administrador', () => {
    const example = fileURLToPath(new URL('../../config/circuit-access.example.yaml', import.meta.url));
    const parsed = RolePolicyLoader.loadFile(example, registry);
    expect([...parsed.sqlRoles]).toEqual(['administrador']);
    expect(parsed.canUseSql('ventas')).toBe(false);
  });

  it.each(['"si"', '1', 'yes please'])('refuses a non-boolean sql flag (%s)', (value) => {
    expect(() => RolePolicyLoader.parse(`roles:\n  a:\n    circuits: [venta]\n    sql: ${value}\n`, registry)).toThrow(ConfigurationError);
  });
});

describe('AuthorizationService', () => {
  it('grants only the circuits listed for the role', () => {
    expect(authorization.canAccessCircuit(ventas, 'venta')).toBe(true);
    expect(authorization.canAccessCircuit(ventas, 'compras')).toBe(false);
    expect(authorization.canAccessCircuit(compras, 'compras')).toBe(true);
  });

  it('denies a role not present in circuit-access.yaml', () => {
    expect(authorization.canAccessCircuit(nobody, 'venta')).toBe(false);
  });

  it('denies unknown circuits', () => {
    expect(authorization.canAccessCircuit(ventas, 'inexistente')).toBe(false);
  });

  it('table must be queryable AND in an accessible circuit', () => {
    expect(authorization.canQueryTable(ventas, 'venta', 'stock.factura_venta')).toBe(true);
    expect(authorization.canQueryTable(ventas, 'envio_comprobantes', 'stock.factura_venta')).toBe(true);
    // Same table, accessible circuit where it is needs_review.
    expect(authorization.canQueryTable(compras, 'review_cases', 'stock.factura_venta')).toBe(false);
    // Same table, circuit the role cannot access.
    expect(authorization.canQueryTable(compras, 'venta', 'stock.factura_venta')).toBe(false);
    // Table outside the circuit.
    expect(authorization.canQueryTable(ventas, 'venta', 'compra.orden_compra')).toBe(false);
  });

  it('seguridad.* is queryable only by a role granted the usuario circuit', () => {
    expect(authorization.canAccessCircuit(auditor, 'usuario')).toBe(true);
    for (const table of ['seguridad.usuario', 'seguridad.usuarioxrol', 'seguridad.rol', 'seguridad.view_usuario']) {
      expect(authorization.canQueryTable(auditor, 'usuario', table)).toBe(true);
      expect(authorization.canQueryTable(ventas, 'usuario', table)).toBe(false);
    }
  });
});

describe('CircuitPolicyService', () => {
  it('getAvailableCircuits lists only allowed circuits', () => {
    expect(circuits.getAvailableCircuits(ventas).map((circuit) => circuit.id)).toEqual(['venta', 'envio_comprobantes']);
    expect(circuits.getAvailableCircuits(nobody)).toEqual([]);
  });

  it('describeCircuit distinguishes missing vs forbidden circuits', () => {
    expect(() => circuits.describeCircuit(ventas, 'nope')).toThrow(CircuitNotFoundError);
    expect(() => circuits.describeCircuit(ventas, 'compras')).toThrow(AuthorizationError);
  });

  it('describeCircuit exposes columns only for queryable tables', () => {
    const description = circuits.describeCircuit(compras, 'compras');
    const normal = description.tables.find((table) => table.table === 'compra.orden_compra');
    expect(normal).toMatchObject({ queryable: true });
    expect(normal?.columns).toContain('nordencompra');

    const legacy = circuits
      .describeCircuit(compras, 'review_cases')
      .tables.find((table) => table.table === 'stock.factura_compra');
    expect(legacy).toMatchObject({ queryable: false, status: ['needs_review', 'legacy'] });
    expect(legacy?.columns).toBeUndefined();
  });

  it('describeCircuit shows pending_columns as information', () => {
    const items = circuits
      .describeCircuit(compras, 'review_cases')
      .tables.find((table) => table.table === 'compra.facturas_compra_items');
    expect(items?.pendingColumns?.[0]).toMatchObject({ column: 'fimpinterno', status: 'not_implemented' });
    expect(items?.columns).not.toContain('fimpinterno');
  });

  it('getQueryableTable rejects non-queryable tables with a reason', () => {
    expect(() => circuits.getQueryableTable(compras, 'review_cases', 'stock.factura_compra')).toThrow(/legacy/);
    expect(() => circuits.getQueryableTable(compras, 'review_cases', 'stock.articulo')).toThrow(TableNotAllowedError);
  });

  it('seguridad tables never expose sensitive columns', () => {
    const usuario = circuits.getQueryableTable(auditor, 'usuario', 'seguridad.usuario');
    for (const column of ['vpassword', 'vhashrecupclave', 'vcodigo2fa', 'bautenticacion2fa', 'bbloqueoauto', 'dfechanacimiento']) {
      expect(circuits.isColumnSelectable(usuario, column), column).toBe(false);
    }
    expect(circuits.isColumnSelectable(usuario, 'nusuario')).toBe(true);
  });

  it('pending columns are not selectable, filterable nor sortable', () => {
    const items = circuits.getQueryableTable(compras, 'review_cases', 'compra.facturas_compra_items');
    expect(circuits.isColumnSelectable(items, 'fimpinterno')).toBe(false);
    expect(circuits.isColumnFilterable(items, 'fimpinterno')).toBe(false);
    expect(circuits.isColumnSortable(items, 'fimpinterno')).toBe(false);
    expect(circuits.isColumnSelectable(items, 'narticulo')).toBe(true);
  });
});

describe('Authentication', () => {
  const tokenA = generateToken();
  const tokenDisabled = generateToken();
  const users = new InMemoryUserRepository([
    { id: 'u1', username: 'ana', role: 'ventas', databaseKey: 'lang', enabled: true, tokenSha256: hashToken(tokenA), createdAt: '' },
    { id: 'u2', username: 'beto', role: 'ventas', databaseKey: 'lang', enabled: false, tokenSha256: hashToken(tokenDisabled), createdAt: '' },
  ]);
  const middleware = new AuthMiddleware(new TokenVerifier(users), users);

  it('valid token → UserContext built server-side', async () => {
    const context = await middleware.authenticate({ headers: { authorization: `Bearer ${tokenA}` } });
    expect(context).toEqual({ userId: 'u1', role: 'ventas', databaseKey: 'lang' });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it.each([
    ['no header', {}],
    ['wrong scheme', { authorization: `Basic ${tokenA}` }],
    ['unknown token', { authorization: `Bearer ${generateToken()}` }],
    ['garbage token', { authorization: "Bearer ' OR 1=1 --" }],
    ['disabled user', { authorization: `Bearer ${tokenDisabled}` }],
  ])('rejects %s', async (_case, headers) => {
    await expect(middleware.authenticate({ headers })).rejects.toThrow(AuthenticationError);
  });
});
