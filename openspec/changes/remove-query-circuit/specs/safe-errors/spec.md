# Spec Delta

## MODIFIED Requirements

### Requirement: Códigos públicos
Los errores visibles SHALL ser `AppError` con uno de estos códigos: `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `CIRCUIT_NOT_FOUND`, `INVALID_QUERY`, `DATABASE_QUERY_ERROR`, `QUERY_TIMEOUT`, `RATE_LIMIT_EXCEEDED`, `CONFIGURATION_ERROR`, `INTERNAL_ERROR`.

#### Scenario: Error no previsto
- **WHEN** una tool lanza un error que no es `AppError`
- **THEN** el cliente recibe `INTERNAL_ERROR` con "An internal error occurred" y el detalle va solo a stderr

#### Scenario: Código eliminado
- **WHEN** falla cualquier llamada
- **THEN** el código nunca es `TABLE_NOT_ALLOWED` ni `COLUMN_NOT_ALLOWED`

### Requirement: Traducción por SQLSTATE
Los errores de PostgreSQL SHALL mapearse por SQLSTATE a un código público y un mensaje genérico: `57014` → `QUERY_TIMEOUT`; clase `22` → `INVALID_QUERY` ("A value is not valid for its type"); `42501` → `AUTHORIZATION_ERROR`; `42P01`/`42703` → `DATABASE_QUERY_ERROR` ("A table or column in the statement does not exist in this database"); `42883` → `INVALID_QUERY`; el resto → `DATABASE_QUERY_ERROR` genérico. El texto de PostgreSQL solo viaja en `diagnostics` (ver "Diagnóstico de SQL en query_sql").

#### Scenario: Valor de tipo incorrecto
- **WHEN** el SQL compara una columna integer con `'abc'`
- **THEN** el cliente recibe `INVALID_QUERY` "A value is not valid for its type"

#### Scenario: Permiso denegado por la base
- **WHEN** PostgreSQL responde `42501`
- **THEN** el cliente recibe `AUTHORIZATION_ERROR` "The database denied access to this table"

#### Scenario: Base caída
- **WHEN** no se puede obtener una conexión
- **THEN** el cliente recibe `DATABASE_QUERY_ERROR` "The database is not available"

### Requirement: Diagnóstico de SQL en query_sql
Cuando PostgreSQL rechaza una sentencia de `query_sql`, el error SHALL incluir `sqlState`, el mensaje de PostgreSQL y, si existen, `hint` y `position`, para que el modelo corrija su SQL. El código público se elige con el mapeo por SQLSTATE.

#### Scenario: Error de sintaxis
- **WHEN** el modelo envía `SELEC 1`
- **THEN** recibe `DATABASE_QUERY_ERROR` con `sqlState: "42601"`, el mensaje `syntax error at or near "SELEC"` y la posición

#### Scenario: Columna inexistente
- **WHEN** el modelo selecciona una columna que no existe
- **THEN** recibe el mensaje de PostgreSQL con el nombre de la columna y el `hint` si lo hay

#### Scenario: Permiso denegado
- **WHEN** el modelo lee una columna sin grant
- **THEN** recibe `AUTHORIZATION_ERROR` con `sqlState: "42501"` y el mensaje de PostgreSQL
