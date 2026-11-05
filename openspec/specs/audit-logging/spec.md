# audit-logging Specification

## Purpose
Registra un evento de auditoría por cada llamada a una tool, con suficiente contexto para trazar quién consultó qué, sin guardar datos sensibles ni resultados.

## Requirements

### Requirement: Un evento por llamada
Cada llamada a una tool, exitosa o fallida, SHALL generar un evento con `timestamp`, `userId`, `role`, `databaseKey`, `tool`, `durationMs` y `success`. Si aplica, el evento MUST incluir `circuit`, `table`, `columns`, `filterFields`, y `rowCount` cuando hay éxito o `errorCode` cuando hay fallo.

#### Scenario: Consulta exitosa
- **WHEN** `query_circuit` devuelve 12 filas
- **THEN** se registra un evento con `success: true` y `rowCount: 12`

#### Scenario: Consulta rechazada
- **WHEN** `query_circuit` falla por columna no permitida
- **THEN** se registra un evento con `success: false` y `errorCode: "COLUMN_NOT_ALLOWED"`

### Requirement: Sin datos sensibles
Los eventos de auditoría MUST NOT contener el token Bearer, contraseñas, connection strings, valores de filtros ni filas de resultado. De los filtros solo se registran los nombres de campo.

#### Scenario: Filtro por CUIT
- **WHEN** se filtra por `vcuit eq "20-12345678-9"`
- **THEN** el evento registra `filterFields: ["vcuit"]` y no el valor

### Requirement: Destino JSON Lines
Los eventos SHALL escribirse como JSON Lines con `type: "audit"` en `AUDIT_LOG_FILE` (permisos 0600) o, si no está configurado o la escritura falla, en stderr.

#### Scenario: Archivo no escribible
- **WHEN** falla la escritura en `AUDIT_LOG_FILE`
- **THEN** el evento se escribe en stderr y la tool no falla por eso

### Requirement: Auditoría de query_sql
Cada llamada a `query_sql` SHALL registrar, además de los campos comunes, `sqlSha256` (hash hex del texto SQL), `sqlLength`, y si tiene éxito `rowCount` y `truncated`. El texto del SQL MUST NOT registrarse, porque sus literales pueden contener datos personales.

#### Scenario: Consulta exitosa
- **WHEN** `query_sql` devuelve 1000 filas truncadas
- **THEN** el evento tiene `sqlSha256`, `sqlLength`, `rowCount: 1000`, `truncated: true` y `success: true`

#### Scenario: SQL con un CUIT
- **WHEN** el SQL contiene `WHERE vcuit = '20-12345678-9'`
- **THEN** el evento no contiene ese valor

#### Scenario: Consulta rechazada
- **WHEN** `query_sql` falla por permiso denegado
- **THEN** el evento tiene `success: false`, `errorCode: "AUTHORIZATION_ERROR"` y el `sqlSha256`
