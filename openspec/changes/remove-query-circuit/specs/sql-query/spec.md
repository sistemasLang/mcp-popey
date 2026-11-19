# Spec Delta

## MODIFIED Requirements

### Requirement: Timeout de query_sql
Cada sentencia SHALL cancelarse si supera `QUERY_SQL_TIMEOUT_MS` (default 30000 ms), configurable por entorno.

#### Scenario: Consulta lenta
- **WHEN** una sentencia tarda más que el timeout configurado
- **THEN** PostgreSQL la cancela y el cliente recibe `QUERY_TIMEOUT`

### Requirement: Tipos de resultado de query_sql
Las columnas `DATE` SHALL devolverse como `YYYY-MM-DD`. `columns` MUST listar los nombres de columna en el orden en que los devuelve la sentencia.

#### Scenario: Fecha
- **WHEN** la sentencia devuelve una columna DATE `2026-10-01`
- **THEN** el valor es exactamente `"2026-10-01"`

### Requirement: Tenant del UserContext
`query_sql` SHALL ejecutarse siempre sobre la base de `UserContext.databaseKey`. El SQL MUST NOT poder elegir ni conectarse a otra base del servidor.

#### Scenario: Intento de cambiar de base
- **WHEN** el modelo envía `\\c otra_base` o intenta usar `dblink` hacia otra base
- **THEN** la llamada falla y no se lee ninguna otra base
