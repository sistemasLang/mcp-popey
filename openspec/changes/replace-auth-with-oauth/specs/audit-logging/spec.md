# Spec Delta

## MODIFIED Requirements

### Requirement: Un evento por llamada
Cada llamada a una tool, exitosa o fallida, SHALL generar un evento con `timestamp`, `userId` (el `id` interno), `principalKind` (`human` o `service`), `role`, `databaseKey`, `tool`, `durationMs` y `success`. Si aplica, el evento MUST incluir `circuit`, `table`, `columns`, `filterFields`, y `rowCount` cuando hay éxito o `errorCode` cuando hay fallo.

#### Scenario: Consulta exitosa
- **WHEN** `query_circuit` devuelve 12 filas
- **THEN** se registra un evento con `success: true` y `rowCount: 12`

#### Scenario: Consulta rechazada
- **WHEN** `query_circuit` falla por columna no permitida
- **THEN** se registra un evento con `success: false` y `errorCode: "COLUMN_NOT_ALLOWED"`

#### Scenario: Consulta de n8n
- **WHEN** la cuenta de servicio de n8n llama a `query_sql`
- **THEN** el evento tiene `principalKind: "service"` y el `userId` interno de la cuenta

### Requirement: Sin datos sensibles
Los eventos de auditoría MUST NOT contener access tokens, refresh tokens, contraseñas, secretos de clientes, connection strings, valores de filtros ni filas de resultado. De los filtros solo se registran los nombres de campo.

#### Scenario: Filtro por CUIT
- **WHEN** se filtra por `vcuit eq "20-12345678-9"`
- **THEN** el evento registra `filterFields: ["vcuit"]` y no el valor

#### Scenario: Rotación de secreto
- **WHEN** un admin rota el secreto de una cuenta de servicio
- **THEN** el evento administrativo no contiene el secreto nuevo ni el anterior

## ADDED Requirements

### Requirement: Auditoría de acciones administrativas
Cada escritura de la API de administración, exitosa o fallida, y cada alta del bootstrap SHALL generar un evento `type: "admin"` con `timestamp`, `actorUserId` (o `"bootstrap"`), `action`, `targetUserId`, `changedFields`, `success` y, si falla, `errorCode`. Se escribe en el mismo destino que la auditoría de tools.

#### Scenario: Acciones registradas
- **WHEN** se invita, actualiza, deshabilita o habilita un usuario, se emite un link para elegir contraseña, o se crea una cuenta de servicio o se rota su secreto
- **THEN** el evento tiene `action` igual a `invite_user`, `update_user`, `disable_user`, `enable_user`, `issue_password_link`, `create_service_account` o `rotate_service_secret`

#### Scenario: Alta por bootstrap
- **WHEN** el bootstrap vincula a un admin al arrancar
- **THEN** el evento tiene `actorUserId: "bootstrap"` y `action: "bootstrap_admin"`

### Requirement: Acciones administrativas sin datos sensibles
Los eventos `type: "admin"` MUST NOT contener emails, el `subject` del IdP, secretos, tokens ni links para elegir contraseña.

#### Scenario: Link emitido
- **WHEN** un admin regenera el link de una persona
- **THEN** se registra `action: "issue_password_link"` con `actorUserId` y `targetUserId`, sin la URL

#### Scenario: Cambio de rol
- **WHEN** un admin cambia el rol de un usuario de `ventas` a `general`
- **THEN** se registra `action: "update_user"` con `actorUserId`, `targetUserId` y `changedFields: ["role"]`

#### Scenario: Operación rechazada
- **WHEN** el último admin intenta deshabilitarse
- **THEN** se registra el evento con `success: false` y `errorCode: "LAST_ADMIN"`

#### Scenario: Invitación sin PII en el log
- **WHEN** un admin invita a `juan@empresa.com`
- **THEN** el evento registra el `targetUserId` interno y no el email
