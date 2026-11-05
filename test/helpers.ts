import { fileURLToPath } from 'node:url';
import { CircuitLoader } from '../src/circuits/circuit.loader.js';
import { CircuitRegistry } from '../src/circuits/circuit.registry.js';

export const REAL_CIRCUITS_PATH = fileURLToPath(new URL('../config/circuits.yaml', import.meta.url));

/**
 * Deny-by-default cases (needs_review, legacy, pending, documentary or empty
 * key_columns). The real circuits.yaml is fully verified against the live
 * database and no longer contains any of them, so they live here instead.
 */
export const REVIEW_CASES_YAML = `
circuits:
  review_cases:
    description: "Fixture: tables the registry must refuse to query"
    tables:
      - table: stock.articulo
        role: needs_review table (scalar status)
        key_columns: [narticulo]
        status: needs_review
      - table: stock.factura_venta
        role: same table as in venta, but needs_review in this circuit
        key_columns: [nfacturaventa]
        status: needs_review
      - table: stock.factura_compra
        role: legacy + needs_review table
        key_columns: [nfacturacompra, "..."]
        status: [needs_review, legacy]
      - table: stock.facturacompraxitem
        role: empty key_columns
        key_columns: []
      - table: venta.cuenta_corriente
        role: documentary key_columns only
        key_columns: ["columnas no confirmadas en detalle"]
      - table: e_plataforma.bridge
        role: documentary and real key_columns mixed
        key_columns: [nbridge, "accessKey/secretKey (nombres exactos no confirmados)", nusuariocreador, nusuarioactualiza]
      - table: compra.facturas_compra_items
        role: table with a pending column
        key_columns: [narticulo, ncantidad]
    pending_columns:
      - table: compra.facturas_compra_items
        column: fimpinterno
        status: not_implemented
`;

export function loadRealRegistry(): CircuitRegistry {
  return CircuitRegistry.fromDefinitions(CircuitLoader.loadFile(REAL_CIRCUITS_PATH));
}

/** Real circuits plus the `review_cases` fixture circuit. */
export function loadTestRegistry(): CircuitRegistry {
  return CircuitRegistry.fromDefinitions([
    ...CircuitLoader.loadFile(REAL_CIRCUITS_PATH),
    ...CircuitLoader.parse(REVIEW_CASES_YAML),
  ]);
}
