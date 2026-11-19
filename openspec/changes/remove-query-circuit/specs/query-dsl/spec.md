# Spec Delta

## REMOVED Requirements

### Requirement: Validación completa, sin correcciones silenciosas
**Reason**: Se elimina la tool `query_circuit` y con ella el DSL.
**Migration**: Consultar con `query_sql`.

### Requirement: Select
**Reason**: Se elimina la tool `query_circuit` y con ella el DSL.
**Migration**: Consultar con `query_sql`.

### Requirement: Filtros
**Reason**: Se elimina la tool `query_circuit` y con ella el DSL.
**Migration**: Consultar con `query_sql` (`WHERE`).

### Requirement: Orden y límite
**Reason**: Se elimina la tool `query_circuit` y con ella el DSL.
**Migration**: Consultar con `query_sql` (`ORDER BY`, `LIMIT`); la respuesta se acota con `QUERY_SQL_MAX_ROWS`.

### Requirement: Compilación a SQL parametrizado
**Reason**: Ya no hay SQL compilado por el servidor; el único SQL es el de `query_sql`, que no se reescribe.
**Migration**: Ninguna.

### Requirement: Semántica de operadores
**Reason**: Se elimina la tool `query_circuit` y con ella el DSL.
**Migration**: Consultar con `query_sql`.
