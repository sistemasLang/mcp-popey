# Spec Delta

## ADDED Requirements

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
