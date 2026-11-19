import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UserContext } from '../../api/domain/user-context.js';
import { CircuitPolicyService } from '../../api/application/services/circuit-policy.service.js';
import { AuthorizationError, CircuitNotFoundError, ConfigurationError } from '../../api/domain/errors.js';
import { AuthorizationService } from '../../api/application/services/authorization.service.js';
import { RolePolicyLoader } from '../../api/adapters/outbound/yaml/role-policy.loader.js';
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

  it('the shipped example loads', () => {
    const example = fileURLToPath(new URL('../../config/circuit-access.example.yaml', import.meta.url));
    expect([...RolePolicyLoader.loadFile(example, registry).roles.keys()]).toEqual(['ventas', 'compras', 'administrador']);
  });

  it('refuses the removed per-role sql flag instead of silently ignoring it', () => {
    expect(() => RolePolicyLoader.parse('roles:\n  a:\n    circuits: [venta]\n    sql: true\n', registry)).toThrow(
      ConfigurationError,
    );
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

  it('query_sql is available to every role in circuit-access.yaml, whatever its circuits', () => {
    expect(authorization.canUseSql(ventas)).toBe(true);
    expect(authorization.canUseSql(auditor)).toBe(true);
    const noCircuits = RolePolicyLoader.parse('roles:\n  analista: {}\n', registry);
    expect(new AuthorizationService(noCircuits, registry).canUseSql({ userId: 'x', role: 'analista', databaseKey: 'a' })).toBe(true);
  });

  it('denies query_sql to a role not present in circuit-access.yaml', () => {
    expect(authorization.canUseSql(nobody)).toBe(false);
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

  it('describeCircuit never lists sensitive seguridad columns', () => {
    const usuario = circuits.describeCircuit(auditor, 'usuario').tables.find((table) => table.table === 'seguridad.usuario');
    expect(usuario?.columns).toContain('nusuario');
    for (const column of ['vpassword', 'vhashrecupclave', 'vcodigo2fa', 'bautenticacion2fa', 'bbloqueoauto', 'dfechanacimiento']) {
      expect(usuario?.columns, column).not.toContain(column);
    }
  });
});

