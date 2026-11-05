import { describe, expect, it } from 'vitest';
import type { UserContext } from '../../src/auth/user-context.js';
import { CircuitPolicyService } from '../../src/circuits/circuit-policy.service.js';
import {
  AuthorizationError,
  CircuitNotFoundError,
  ColumnNotAllowedError,
  InternalError,
  InvalidQueryError,
  TableNotAllowedError,
} from '../../src/errors/app-errors.js';
import { AuthorizationService } from '../../src/permissions/authorization.service.js';
import { RolePolicyLoader } from '../../src/permissions/role-policy.loader.js';
import { escapeLike, QueryCompiler, quoteIdentifier } from '../../src/query/query.compiler.js';
import { QueryCircuitSchema } from '../../src/query/query.schema.js';
import type { QueryCircuitRequest, ValidatedQuery } from '../../src/query/query.types.js';
import { QueryValidator } from '../../src/query/query.validator.js';
import { QUERY_LIMITS } from '../../src/security/query-limits.js';
import { loadTestRegistry } from '../helpers.js';

const registry = loadTestRegistry();
const policy = RolePolicyLoader.parse(
  'roles:\n  ventas:\n    circuits: [venta, envio_comprobantes, usuario, review_cases]\n  compras:\n    circuits: [compras, review_cases]\n',
  registry,
);
const circuits = new CircuitPolicyService(registry, new AuthorizationService(policy, registry));
const validator = new QueryValidator(circuits, QUERY_LIMITS);
const compiler = new QueryCompiler();

const ventas: UserContext = { userId: '15', role: 'ventas', databaseKey: 'lang' };
const compras: UserContext = { userId: '16', role: 'compras', databaseKey: 'lang' };

const base: QueryCircuitRequest = {
  circuit: 'venta',
  table: 'stock.factura_venta',
  select: ['nfacturaventa', 'dfecha', 'ftotal'],
};

const compile = (request: QueryCircuitRequest, user = ventas) => compiler.compile(validator.validate(user, request));

describe('QueryValidator', () => {
  it('accepts a valid request and applies the default limit', () => {
    const validated = validator.validate(ventas, base);
    expect(validated.columns).toEqual(['nfacturaventa', 'dfecha', 'ftotal']);
    expect(validated.limit).toBe(QUERY_LIMITS.defaultRows);
    expect(validated.table.qualifiedName).toBe('stock.factura_venta');
  });

  it.each<[string, Partial<QueryCircuitRequest>, new (...args: never[]) => Error]>([
    ['1. unknown circuit', { circuit: 'nope' }, CircuitNotFoundError],
    ['2. circuit not granted to role', { circuit: 'compras', table: 'compra.orden_compra', select: ['nordencompra'] }, AuthorizationError],
    ['3. table outside circuit', { table: 'compra.orden_compra', select: ['nordencompra'] }, TableNotAllowedError],
    ['4. table without confirmed columns', { circuit: 'review_cases', table: 'venta.cuenta_corriente', select: ['ncliente'] }, TableNotAllowedError],
    ['6. needs_review table', { circuit: 'review_cases', select: ['nfacturaventa'] }, TableNotAllowedError],
    ['7. seguridad table outside the usuario circuit', { table: 'seguridad.usuario', select: ['nusuario'] }, TableNotAllowedError],
    ['7. sensitive seguridad column', { circuit: 'usuario', table: 'seguridad.usuario', select: ['vpassword'] }, ColumnNotAllowedError],
    ['8. unknown column', { select: ['nfacturaventa', 'vpassword'] }, ColumnNotAllowedError],
    ['8. duplicated column', { select: ['dfecha', 'dfecha'] }, InvalidQueryError],
    ['10. filter on unknown column', { filters: [{ field: 'nope', operator: 'eq', value: 1 }] }, ColumnNotAllowedError],
    ['11. operator missing value', { filters: [{ field: 'dfecha', operator: 'gte' }] }, InvalidQueryError],
    ['11. isNull with value', { filters: [{ field: 'dfecha', operator: 'isNull', value: 1 }] }, InvalidQueryError],
    ['11. in with scalar', { filters: [{ field: 'ncliente', operator: 'in', value: 5 }] }, InvalidQueryError],
    ['11. in with empty array', { filters: [{ field: 'ncliente', operator: 'in', value: [] }] }, InvalidQueryError],
    ['11. contains with number', { filters: [{ field: 'vnumero', operator: 'contains', value: 5 }] }, InvalidQueryError],
    ['11. object as value', { filters: [{ field: 'ncliente', operator: 'eq', value: { $gt: 1 } }] }, InvalidQueryError],
    ['11. null as value', { filters: [{ field: 'ncliente', operator: 'eq', value: null }] }, InvalidQueryError],
    ['12. order by unknown column', { orderBy: [{ field: 'random()', direction: 'asc' }] }, ColumnNotAllowedError],
    ['13. bad direction', { orderBy: [{ field: 'dfecha', direction: 'DESC; DROP' as 'asc' }] }, InvalidQueryError],
    ['14. limit above max', { limit: QUERY_LIMITS.maxRows + 1 }, InvalidQueryError],
    ['14. limit zero', { limit: 0 }, InvalidQueryError],
  ])('rejects: %s', (_case, override, errorType) => {
    expect(() => validator.validate(ventas, { ...base, ...override })).toThrow(errorType);
  });

  it('rejects pending columns everywhere, naming the reason', () => {
    const request: QueryCircuitRequest = { circuit: 'review_cases', table: 'compra.facturas_compra_items', select: ['fimpinterno'] };
    expect(() => validator.validate(compras, request)).toThrow(/pending/);
    expect(() =>
      validator.validate(compras, { ...request, select: ['narticulo'], filters: [{ field: 'fimpinterno', operator: 'isNull' }] }),
    ).toThrow(ColumnNotAllowedError);
    expect(() =>
      validator.validate(compras, { ...request, select: ['narticulo'], orderBy: [{ field: 'fimpinterno', direction: 'asc' }] }),
    ).toThrow(ColumnNotAllowedError);
  });

  it('enforces configurable limits', () => {
    const tight = new QueryValidator(circuits, { ...QUERY_LIMITS, maxSelectedColumns: 2, maxFilters: 1 });
    expect(() => tight.validate(ventas, base)).toThrow(/At most 2 columns/);
    expect(() =>
      tight.validate(ventas, {
        ...base,
        select: ['dfecha'],
        filters: [
          { field: 'dfecha', operator: 'isNotNull' },
          { field: 'ftotal', operator: 'gt', value: 0 },
        ],
      }),
    ).toThrow(/At most 1 filters/);
  });

  it('never auto-corrects: an over-limit request is rejected, not clamped', () => {
    expect(() => validator.validate(ventas, { ...base, limit: 10_000 })).toThrow(InvalidQueryError);
  });
});

describe('QueryCompiler', () => {
  it('compiles the plan example', () => {
    const compiled = compile({ ...base, filters: [{ field: 'dfecha', operator: 'gte', value: '2026-10-01' }] });
    expect(compiled.sql).toBe(
      'SELECT "nfacturaventa", "dfecha", "ftotal"\nFROM "stock"."factura_venta"\nWHERE "dfecha" >= $1\nLIMIT $2',
    );
    expect(compiled.params).toEqual(['2026-10-01', 100]);
  });

  it('compiles every operator with parameters only', () => {
    const compiled = compile({
      ...base,
      filters: [
        { field: 'ncliente', operator: 'eq', value: 7 },
        { field: 'nestadofactura', operator: 'neq', value: 2 },
        { field: 'ftotal', operator: 'gt', value: 10 },
        { field: 'ftotal', operator: 'lt', value: 99.5 },
        { field: 'dfecha', operator: 'lte', value: '2026-12-31' },
        { field: 'ndeposito', operator: 'in', value: [1, 2, 3] },
        { field: 'vnumero', operator: 'contains', value: '0001' },
        { field: 'vafip_cae', operator: 'startsWith', value: '7' },
        { field: 'nestadonc', operator: 'isNull' },
        { field: 'bpagada', operator: 'isNotNull' },
      ],
      orderBy: [
        { field: 'dfecha', direction: 'desc' },
        { field: 'nfacturaventa', direction: 'asc' },
      ],
      limit: 50,
    });
    expect(compiled.sql).toBe(
      [
        'SELECT "nfacturaventa", "dfecha", "ftotal"',
        'FROM "stock"."factura_venta"',
        'WHERE "ncliente" = $1 AND "nestadofactura" <> $2 AND "ftotal" > $3 AND "ftotal" < $4' +
          ' AND "dfecha" <= $5 AND "ndeposito" = ANY($6)' +
          ` AND "vnumero"::text ILIKE $7 ESCAPE '\\' AND "vafip_cae"::text ILIKE $8 ESCAPE '\\'` +
          ' AND "nestadonc" IS NULL AND "bpagada" IS NOT NULL',
        'ORDER BY "dfecha" DESC, "nfacturaventa" ASC',
        'LIMIT $9',
      ].join('\n'),
    );
    expect(compiled.params).toEqual([7, 2, 10, 99.5, '2026-12-31', [1, 2, 3], '%0001%', '7%', 50]);
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    const compiled = compile({ ...base, filters: [{ field: 'vnumero', operator: 'contains', value: '%' }] });
    expect(compiled.params[0]).toBe('%\\%%');
  });

  it('refuses unsafe identifiers even if they bypass the validator', () => {
    expect(() => quoteIdentifier('x"; DROP TABLE y; --')).toThrow(InternalError);
    const forged = { ...validator.validate(ventas, base), columns: ['nfacturaventa, (SELECT 1)'] } as ValidatedQuery;
    expect(() => compiler.compile(forged)).toThrow(InternalError);
  });
});

describe('SQL injection', () => {
  const payloads = [
    '1 OR 1=1',
    "'; DROP TABLE stock.articulo; --",
    'UNION SELECT vpassword FROM seguridad.usuario',
    'stock.articulo; DELETE FROM stock.articulo',
    "x' OR 'a'='a",
    '$1',
    '"; --',
  ];

  it.each(payloads)('as a VALUE it is parameterized, never inlined: %s', (payload) => {
    const withValue = (value: string) =>
      compile({
        ...base,
        filters: [
          { field: 'vnumero', operator: 'eq', value },
          { field: 'vafip_cae', operator: 'in', value: [value] },
          { field: 'vnumero', operator: 'contains', value },
        ],
      });
    const malicious = withValue(payload);
    // The SQL text does not depend on the value at all.
    expect(malicious.sql).toBe(withValue('benign').sql);
    expect(malicious.sql).not.toMatch(/DROP|DELETE|UNION|OR 1=1/i);
    expect(malicious.params).toContain(payload);
  });

  it.each(payloads)('as a TABLE it is rejected: %s', (payload) => {
    expect(() => validator.validate(ventas, { ...base, table: payload })).toThrow(TableNotAllowedError);
  });

  it.each(payloads)('as a COLUMN (select/filter/order) it is rejected: %s', (payload) => {
    expect(() => validator.validate(ventas, { ...base, select: [payload] })).toThrow(ColumnNotAllowedError);
    expect(() =>
      validator.validate(ventas, { ...base, filters: [{ field: payload, operator: 'eq', value: 1 }] }),
    ).toThrow(ColumnNotAllowedError);
    expect(() =>
      validator.validate(ventas, { ...base, orderBy: [{ field: payload, direction: 'asc' }] }),
    ).toThrow(ColumnNotAllowedError);
  });

  it.each(payloads)('as a CIRCUIT it is rejected: %s', (payload) => {
    expect(() => validator.validate(ventas, { ...base, circuit: payload })).toThrow(CircuitNotFoundError);
  });

  it('table names are matched exactly (no case or whitespace tricks)', () => {
    for (const table of ['STOCK.FACTURA_VENTA', ' stock.factura_venta', 'stock.factura_venta ', '"stock"."factura_venta"']) {
      expect(() => validator.validate(ventas, { ...base, table })).toThrow(TableNotAllowedError);
    }
  });
});

describe('QueryCircuitSchema (tool input)', () => {
  it.each(['databaseKey', 'database', 'host', 'schema', 'sql', 'rawQuery', 'query'])(
    'rejects the forbidden property "%s"',
    (property) => {
      const result = QueryCircuitSchema.safeParse({ ...base, [property]: 'B' });
      expect(result.success).toBe(false);
    },
  );

  it('rejects extra properties inside filters', () => {
    const result = QueryCircuitSchema.safeParse({
      ...base,
      filters: [{ field: 'dfecha', operator: 'eq', value: 'x', raw: 'OR 1=1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown operators', () => {
    const result = QueryCircuitSchema.safeParse({ ...base, filters: [{ field: 'dfecha', operator: 'raw', value: '1' }] });
    expect(result.success).toBe(false);
  });

  it('requires at least one selected column', () => {
    expect(QueryCircuitSchema.safeParse({ ...base, select: [] }).success).toBe(false);
  });
});
