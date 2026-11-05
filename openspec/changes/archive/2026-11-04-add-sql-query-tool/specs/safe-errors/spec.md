# Spec Delta

## ADDED Requirements

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
