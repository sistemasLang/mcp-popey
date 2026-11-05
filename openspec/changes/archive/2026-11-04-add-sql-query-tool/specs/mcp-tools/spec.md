# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Solo tres tools de lectura`
- TO: `### Requirement: Tools de lectura`

## MODIFIED Requirements

### Requirement: Tools de lectura
El servidor SHALL registrar las tools `list_circuits`, `describe_circuit` y `query_circuit` para todo usuario autenticado, y `query_sql` solo para usuarios cuyo rol tenga `sql: true`. Todas MUST declarar `readOnlyHint: true` y `openWorldHint: false`. El servidor MUST NOT exponer ninguna tool que escriba datos.

#### Scenario: Listado de tools
- **WHEN** un usuario cuyo rol no tiene `sql: true` pide `tools/list`
- **THEN** recibe únicamente `list_circuits`, `describe_circuit` y `query_circuit`

#### Scenario: Listado de tools para un rol con SQL
- **WHEN** un usuario cuyo rol tiene `sql: true` pide `tools/list`
- **THEN** recibe además `query_sql`

#### Scenario: Intento de usar query_sql sin habilitación
- **WHEN** un usuario cuyo rol no tiene `sql: true` invoca `query_sql`
- **THEN** la llamada falla porque la tool no existe para ese usuario

#### Scenario: Intento de tool inexistente
- **WHEN** un cliente invoca una tool como `execute_write`
- **THEN** la llamada falla porque la tool no existe
