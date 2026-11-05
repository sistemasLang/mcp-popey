import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CircuitLoader } from '../../src/circuits/circuit.loader.js';
import { CircuitRegistry } from '../../src/circuits/circuit.registry.js';
import { ConfigurationError } from '../../src/errors/app-errors.js';
import { isBlockedSchema } from '../../src/security/blocked-schemas.js';
import { loadRealRegistry, loadTestRegistry, REAL_CIRCUITS_PATH } from '../helpers.js';

describe('CircuitLoader — structural validation', () => {
  it('loads the real circuits.yaml', () => {
    const definitions = CircuitLoader.loadFile(REAL_CIRCUITS_PATH);
    expect(definitions.map((circuit) => circuit.id)).toEqual([
      'venta',
      'compras',
      'despacho_fifo',
      'percepciones_iibb',
      'importacion_articulos',
      'integracion_ecommerce',
      'ordenes_ecommerce',
      'envio_comprobantes',
      'usuario',
      'posventa',
    ]);
  });

  it('normalizes a scalar status into a list', () => {
    const [circuit] = CircuitLoader.parse(`
circuits:
  c:
    description: d
    tables:
      - table: stock.articulo
        role: r
        key_columns: []
        status: needs_review
`);
    expect(circuit?.tables[0]?.status).toEqual(['needs_review']);
  });

  it.each([
    ['missing tables', 'circuits:\n  c:\n    description: d\n'],
    ['table without schema', 'circuits:\n  c:\n    description: d\n    tables:\n      - table: articulo\n        role: r\n'],
    ['SQL in table name', 'circuits:\n  c:\n    description: d\n    tables:\n      - table: "stock.articulo; DROP TABLE x"\n        role: r\n'],
    ['unknown property', 'circuits:\n  c:\n    description: d\n    tables:\n      - table: stock.a\n        role: r\n        sql: "SELECT 1"\n'],
    ['key_columns not a list', 'circuits:\n  c:\n    description: d\n    tables:\n      - table: stock.a\n        role: r\n        key_columns: narticulo\n'],
    ['invalid circuit id', 'circuits:\n  "Venta Total":\n    description: d\n    tables:\n      - table: stock.a\n        role: r\n'],
    ['malformed YAML', 'circuits: [unclosed'],
  ])('refuses to start on a structurally invalid file: %s', (_case, yaml) => {
    expect(() => CircuitLoader.parse(yaml)).toThrow(ConfigurationError);
  });

  it('does NOT fail on documentary key_columns', () => {
    expect(() =>
      CircuitLoader.parse(`
circuits:
  c:
    description: d
    tables:
      - table: venta.cuenta_corriente
        role: r
        key_columns: ["columnas no confirmadas en detalle"]
`),
    ).not.toThrow();
  });
});

describe('CircuitRegistry — real circuits.yaml cases', () => {
  const registry = loadRealRegistry();

  it('normal table: queryable with its confirmed columns', () => {
    const table = registry.getTable('venta', 'stock.factura_venta');
    expect(table?.queryable).toBe(true);
    expect(table?.schema).toBe('stock');
    expect(table?.name).toBe('factura_venta');
    expect(table?.columns).toContain('nfacturaventa');
    expect(table?.columns).toContain('ftotal');
  });

  it('every table outside blocked schemas is queryable (verified against the live database)', () => {
    for (const circuit of registry.list()) {
      for (const table of circuit.tables.values()) {
        if (isBlockedSchema(table.schema)) continue;
        expect(table.denyReasons, `${circuit.id} ${table.qualifiedName}`).toEqual([]);
        expect(table.unconfirmedColumnNotes, `${circuit.id} ${table.qualifiedName}`).toEqual([]);
      }
    }
  });

  it('table duplicated across circuits: evaluated per circuit', () => {
    expect(registry.getTable('venta', 'stock.factura_venta')?.queryable).toBe(true);
    expect(registry.getTable('percepciones_iibb', 'stock.factura_venta')?.columns).toEqual([
      'nfacturaventa',
      'ftotaliibb',
    ]);
    const inReview = loadTestRegistry().getTable('review_cases', 'stock.factura_venta');
    expect(inReview?.queryable).toBe(false);
    expect(inReview?.denyReasons).toContain('needs_review');
  });

  it('table duplicated inside one circuit: entries are merged', () => {
    const table = registry.getTable('importacion_articulos', 'stock.articulo');
    expect(table?.queryable).toBe(true);
    expect(table?.columns).toEqual(['narticulo', 'varticulo', 'vpartnumber', 'ntipostock', 'ncategoria', 'nmarca']);
    expect(table?.description).toContain('Trigger fnc_trg_i_b_articulo_vpartnumber_unico');
  });

  it('secret columns are never part of the allowlist', () => {
    expect(registry.getTable('integracion_ecommerce', 'e_plataforma.bridge')?.columns).not.toContain('vaccesskey');
    expect(registry.getTable('integracion_ecommerce', 'e_plataforma.bridge')?.columns).not.toContain('vsecretkey');
    expect(registry.getTable('integracion_ecommerce', 'e_plataforma.credenciales')?.columns).not.toContain('vaccesstoken');
    expect(registry.getTable('integracion_ecommerce', 'e_plataforma.credenciales')?.columns).not.toContain('vrefreshtoken');
  });

  it('seguridad schema: queryable on purpose, without sensitive columns', () => {
    const sensitive = [
      'vpassword',
      'vhashrecupclave',
      'tsexpiracionhash',
      'tsultimaactpassword',
      'vcodigo2fa',
      'bcodigo2favalidado',
      'bautenticacion2fa',
      'bbloqueoauto',
      'tsbloqueoauto',
      'dfechanacimiento',
    ];
    for (const name of ['seguridad.usuario', 'seguridad.usuarioxrol', 'seguridad.rol', 'seguridad.view_usuario']) {
      const table = registry.getTable('usuario', name);
      expect(table, name).toBeDefined();
      expect(table?.queryable, name).toBe(true);
      for (const column of sensitive) expect(table?.columns, `${name}.${column}`).not.toContain(column);
    }
  });

  it('create_readonly_role.sql grants on seguridad exactly the usuario circuit key_columns', () => {
    const script = readFileSync(fileURLToPath(new URL('../../scripts/create_readonly_role.sql', import.meta.url)), 'utf8');
    const granted = new Map(
      [...script.matchAll(/\('(\w+)', ARRAY\[([^\]]*)\]\)/g)].map(([, table, columns]) => [
        `seguridad.${table}`,
        [...(columns ?? '').matchAll(/'(\w+)'/g)].map(([, column]) => column),
      ]),
    );
    const documented = [...(registry.get('usuario')?.tables.values() ?? [])];
    expect([...granted.keys()].sort()).toEqual(documented.map((table) => table.qualifiedName).sort());
    for (const table of documented) expect(granted.get(table.qualifiedName), table.qualifiedName).toEqual([...table.columns]);
  });

  it('every column name that survives resolution is a plain identifier', () => {
    for (const circuit of registry.list()) {
      for (const table of circuit.tables.values()) {
        for (const column of table.columns) expect(column).toMatch(/^[a-z_][a-z0-9_]*$/);
      }
    }
  });
});

describe('CircuitRegistry — deny-by-default cases (review_cases fixture)', () => {
  const registry = loadTestRegistry();
  const table = (name: string) => registry.getTable('review_cases', name);

  it('needs_review table (scalar status): not queryable', () => {
    expect(table('stock.articulo')?.status).toEqual(['needs_review']);
    expect(table('stock.articulo')?.queryable).toBe(false);
  });

  it('legacy + needs_review table: not queryable even with a real column listed', () => {
    expect(table('stock.factura_compra')?.columns).toEqual(['nfacturacompra']);
    expect(table('stock.factura_compra')?.denyReasons).toEqual(expect.arrayContaining(['needs_review', 'legacy']));
    expect(table('stock.factura_compra')?.queryable).toBe(false);
  });

  it('empty key_columns: not queryable', () => {
    expect(table('stock.facturacompraxitem')?.columns).toEqual([]);
    expect(table('stock.facturacompraxitem')?.denyReasons).toContain('no_confirmed_columns');
    expect(table('stock.facturacompraxitem')?.queryable).toBe(false);
  });

  it('unconfirmed key_columns are documentation, never columns', () => {
    expect(table('venta.cuenta_corriente')?.columns).toEqual([]);
    expect(table('venta.cuenta_corriente')?.unconfirmedColumnNotes[0]).toMatch(/columnas no confirmadas/);
    expect(table('venta.cuenta_corriente')?.queryable).toBe(false);

    expect(table('e_plataforma.bridge')?.columns).toEqual(['nbridge', 'nusuariocreador', 'nusuarioactualiza']);
    expect(table('e_plataforma.bridge')?.unconfirmedColumnNotes).toHaveLength(1);
  });

  it('"..." is not a column', () => {
    expect(table('stock.factura_compra')?.columns).not.toContain('...');
  });

  it('pending_columns are kept as information only', () => {
    expect(table('compra.facturas_compra_items')?.pendingColumns.map((pending) => pending.column)).toEqual(['fimpinterno']);
    expect(table('compra.facturas_compra_items')?.columns).not.toContain('fimpinterno');
  });
});

describe('CircuitRegistry — pending column also listed in key_columns', () => {
  it('pending wins: the column is removed from the queryable set', () => {
    const registry = CircuitRegistry.fromDefinitions(
      CircuitLoader.parse(`
circuits:
  c:
    description: d
    tables:
      - table: compra.facturas_compras
        role: r
        key_columns: [nfacturacompra, ftotalimpinterno]
    pending_columns:
      - table: compra.facturas_compras
        column: ftotalimpinterno
        status: not_implemented
`),
    );
    expect(registry.getTable('c', 'compra.facturas_compras')?.columns).toEqual(['nfacturacompra']);
  });

  it('unknown status value: denied by default', () => {
    const registry = CircuitRegistry.fromDefinitions(
      CircuitLoader.parse(`
circuits:
  c:
    description: d
    tables:
      - table: stock.a
        role: r
        key_columns: [x]
        status: experimental
`),
    );
    const table = registry.getTable('c', 'stock.a');
    expect(table?.queryable).toBe(false);
    expect(table?.denyReasons).toEqual(['unknown_status']);
  });
});
