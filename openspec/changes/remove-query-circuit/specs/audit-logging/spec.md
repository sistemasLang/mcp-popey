# Spec Delta

## MODIFIED Requirements

### Requirement: Un evento por llamada
Cada llamada a una tool, exitosa o fallida, SHALL generar un evento con `timestamp`, `userId` (el `id` interno), `principalKind` (`human` o `service`), `role`, `databaseKey`, `tool`, `durationMs` y `success`. Si aplica, el evento MUST incluir `circuit`, y `rowCount` cuando hay éxito o `errorCode` cuando hay fallo.

#### Scenario: Consulta exitosa
- **WHEN** `query_sql` devuelve 12 filas
- **THEN** se registra un evento con `success: true` y `rowCount: 12`

#### Scenario: Consulta rechazada
- **WHEN** `describe_circuit` falla porque el rol no tiene el circuito
- **THEN** se registra un evento con `circuit`, `success: false` y `errorCode: "AUTHORIZATION_ERROR"`

#### Scenario: Consulta de n8n
- **WHEN** la cuenta de servicio de n8n llama a `query_sql`
- **THEN** el evento tiene `principalKind: "service"` y el `userId` interno de la cuenta

### Requirement: Sin datos sensibles
Los eventos de auditoría MUST NOT contener access tokens, refresh tokens, contraseñas, secretos de clientes, connection strings, texto SQL ni filas de resultado.

#### Scenario: Filtro por CUIT
- **WHEN** el SQL de `query_sql` filtra con `WHERE vcuit = '20-12345678-9'`
- **THEN** el evento no contiene ese valor

#### Scenario: Rotación de secreto
- **WHEN** un admin rota el secreto de una cuenta de servicio
- **THEN** el evento administrativo no contiene el secreto nuevo ni el anterior
