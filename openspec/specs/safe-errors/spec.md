# safe-errors Specification

## Purpose
Asegura que todo error que llega a un cliente MCP tenga un código público estable y un mensaje curado, sin filtrar SQL, texto de PostgreSQL, stack traces ni credenciales.

## Requirements

### Requirement: Códigos públicos
Los errores visibles SHALL ser `AppError` con uno de estos códigos: `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `CIRCUIT_NOT_FOUND`, `TABLE_NOT_ALLOWED`, `COLUMN_NOT_ALLOWED`, `INVALID_QUERY`, `DATABASE_QUERY_ERROR`, `QUERY_TIMEOUT`, `RATE_LIMIT_EXCEEDED`, `CONFIGURATION_ERROR`, `INTERNAL_ERROR`.

#### Scenario: Error no previsto
- **WHEN** una tool lanza un error que no es `AppError`
- **THEN** el cliente recibe `INTERNAL_ERROR` con "An internal error occurred" y el detalle va solo a stderr

### Requirement: Traducción por SQLSTATE
Los errores de PostgreSQL SHALL mapearse por SQLSTATE a mensajes curados, y el texto original de PostgreSQL MUST NOT llegar al cliente: `57014` → `QUERY_TIMEOUT`; clase `22` → `INVALID_QUERY` (valor no válido para el tipo); `42501` → `AUTHORIZATION_ERROR`; `42P01`/`42703` → `DATABASE_QUERY_ERROR` (drift con circuits.yaml); `42883` → `INVALID_QUERY` (operador no soportado para el tipo); el resto → `DATABASE_QUERY_ERROR` genérico.

#### Scenario: Valor de tipo incorrecto
- **WHEN** se filtra una columna integer con `eq "abc"`
- **THEN** el cliente recibe `INVALID_QUERY` "A filter value is not valid for its column type"

#### Scenario: Permiso denegado por la base
- **WHEN** PostgreSQL responde `42501`
- **THEN** el cliente recibe `AUTHORIZATION_ERROR` "The database denied access to this table"

#### Scenario: Base caída
- **WHEN** no se puede obtener una conexión
- **THEN** el cliente recibe `DATABASE_QUERY_ERROR` "The database is not available"

### Requirement: Diagnóstico interno con credenciales redactadas
Los detalles internos SHALL escribirse en stderr como JSON (`type: "internal_error"`), redactando la contraseña de cualquier URL con credenciales (`proto://user:***@`).

#### Scenario: Connection string en un error
- **WHEN** un error interno contiene `postgres://mcp:secreto@host/db`
- **THEN** el log muestra `postgres://mcp:***@host/db`

### Requirement: Diagnóstico de SQL en query_sql
Cuando PostgreSQL rechaza una sentencia de `query_sql`, el error SHALL incluir `sqlState`, el mensaje de PostgreSQL y, si existen, `hint` y `position`, para que el modelo corrija su SQL. El código público se elige con el mismo mapeo por SQLSTATE que `query_circuit`.

#### Scenario: Error de sintaxis
- **WHEN** el modelo envía `SELEC 1`
- **THEN** recibe `DATABASE_QUERY_ERROR` con `sqlState: "42601"`, el mensaje `syntax error at or near "SELEC"` y la posición

#### Scenario: Columna inexistente
- **WHEN** el modelo selecciona una columna que no existe
- **THEN** recibe el mensaje de PostgreSQL con el nombre de la columna y el `hint` si lo hay

#### Scenario: Permiso denegado
- **WHEN** el modelo lee una columna sin grant
- **THEN** recibe `AUTHORIZATION_ERROR` con `sqlState: "42501"` y el mensaje de PostgreSQL

### Requirement: Errores de infraestructura siguen ocultos
Los errores que no vienen de PostgreSQL como respuesta a la sentencia (conexión, socket, configuración) MUST seguir devolviendo mensajes genéricos sin detalles, y todo texto expuesto MUST pasar por la redacción de credenciales.

#### Scenario: Base caída
- **WHEN** no se puede obtener una conexión para `query_sql`
- **THEN** el cliente recibe `DATABASE_QUERY_ERROR` "The database is not available" sin `sqlState` ni detalle
