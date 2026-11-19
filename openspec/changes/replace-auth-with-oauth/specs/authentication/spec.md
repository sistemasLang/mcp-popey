# Spec Delta

## ADDED Requirements

### Requirement: Access token JWT de Auth0 obligatorio
Cada request a `/mcp` SHALL traer `Authorization: Bearer <jwt>`. El servidor MUST verificar localmente la firma contra el JWKS del issuer configurado, aceptar solo `alg: RS256`, y exigir `iss` igual a `https://<AUTH0_DOMAIN>/`, `aud` que contenga `MCP_RESOURCE_URL`, y `exp`/`nbf` vigentes con una tolerancia de 30 s. Cualquier falla MUST responder 401 sin consultar el repositorio de usuarios.

#### Scenario: Header ausente
- **WHEN** el request a `/mcp` no tiene header `Authorization`
- **THEN** el cliente recibe 401 con `WWW-Authenticate: Bearer resource_metadata="<origen>/.well-known/oauth-protected-resource/mcp"`

#### Scenario: Token estático del esquema anterior
- **WHEN** el cliente envía un token opaco de 43 caracteres como los que emitía la CLI
- **THEN** el cliente recibe 401

#### Scenario: Firma inválida
- **WHEN** el JWT está firmado con una clave que no está en el JWKS del issuer
- **THEN** el cliente recibe 401

#### Scenario: Algoritmo no permitido
- **WHEN** el JWT tiene `alg: none` o `alg: HS256`
- **THEN** el cliente recibe 401

#### Scenario: Token vencido
- **WHEN** el `exp` del JWT ya pasó por más de 30 s
- **THEN** el cliente recibe 401

#### Scenario: Issuer ajeno
- **WHEN** el JWT es válido pero su `iss` es otro tenant
- **THEN** el cliente recibe 401

### Requirement: Separación de audiencias
Un token emitido para `ADMIN_API_AUDIENCE` MUST NOT autenticar en `/mcp`, y uno emitido para `MCP_RESOURCE_URL` MUST NOT autenticar en `/admin/api/*`. El servidor nunca reenvía a terceros un token recibido.

#### Scenario: Token del panel contra el MCP
- **WHEN** un admin usa el access token del panel (`aud` admin) en `/mcp`
- **THEN** el cliente recibe 401

#### Scenario: Token del MCP contra la API admin
- **WHEN** un cliente usa un token con `aud` = `MCP_RESOURCE_URL` en `/admin/api/users`
- **THEN** el cliente recibe 401

### Requirement: Metadata de recurso protegido
El servidor SHALL responder sin autenticación `GET /.well-known/oauth-protected-resource/mcp` y `GET /.well-known/oauth-protected-resource` con un JSON que contenga `resource` = `MCP_RESOURCE_URL`, `authorization_servers` = `["https://<AUTH0_DOMAIN>/"]` y `bearer_methods_supported` = `["header"]`. La respuesta MUST NOT incluir secretos ni datos de usuarios.

#### Scenario: Descubrimiento por un cliente MCP
- **WHEN** un cliente recibe 401 en `/mcp` y sigue `resource_metadata`
- **THEN** obtiene la URL del recurso y el issuer de Auth0, sin necesitar token

#### Scenario: Método no permitido
- **WHEN** se hace `POST` a la ruta de metadata
- **THEN** el servidor responde 405 y no ejecuta nada más

### Requirement: Identidad externa mapeada a usuario interno
Tras verificar el token, el servidor SHALL buscar al usuario por el par `(iss, sub)` del JWT. Ningún otro claim (email, roles, permisos, `azp`) MUST influir en la identidad, el rol o el tenant.

#### Scenario: Persona provisionada
- **WHEN** llega un JWT válido cuyo `(iss, sub)` está vinculado al usuario `7c1e…` con rol `ventas` y tenant `lang`
- **THEN** el `UserContext` es `{ userId: "7c1e…", role: "ventas", databaseKey: "lang" }`

#### Scenario: Cuenta de servicio
- **WHEN** llega un JWT de `client_credentials` con `sub` = `<client_id>@clients` vinculado a una cuenta `kind: service`
- **THEN** se construye su `UserContext` igual que el de una persona

#### Scenario: Claim de rol inyectado
- **WHEN** el JWT trae un claim custom `role: "administrador"` y el usuario vinculado tiene rol `ventas`
- **THEN** el `UserContext` usa `ventas` y el claim se ignora

#### Scenario: Identidad no provisionada
- **WHEN** el JWT es válido pero su `(iss, sub)` no está vinculado a ningún usuario
- **THEN** el cliente recibe 403 con el mensaje genérico `Forbidden`

## MODIFIED Requirements

### Requirement: Usuario habilitado
La autenticación en `/mcp` SHALL fallar con 403 y el mensaje genérico `Forbidden` si el usuario vinculado tiene `enabled: false` o no tiene `role` y `databaseKey` asignados. El chequeo MUST hacerse en cada request, de modo que deshabilitar a un usuario corte su acceso aunque tenga access o refresh tokens vigentes.

#### Scenario: Usuario deshabilitado
- **WHEN** un usuario con un access token válido por 10 minutos más es deshabilitado desde el panel
- **THEN** su siguiente request a `/mcp` recibe 403

#### Scenario: Admin sin acceso al ERP
- **WHEN** un admin sin `role` ni `databaseKey` usa un token válido para `/mcp`
- **THEN** recibe 403

#### Scenario: Mismo mensaje en todos los casos
- **WHEN** se comparan las respuestas para identidad no provisionada, usuario deshabilitado y usuario sin rol
- **THEN** las tres son 403 con el mismo cuerpo

### Requirement: UserContext server-side e inmutable
Tras autenticar, el servidor SHALL construir un `UserContext` congelado con `userId` (el `id` interno, nunca el `sub` del IdP), `role` y `databaseKey` del registro del usuario, y lo MUST inyectar a las tools por closure. Ninguna tool puede leer identidad, rol ni base de su input ni del JWT.

#### Scenario: Intento de suplantar el tenant
- **WHEN** un cliente autenticado como tenant `lang` envía `databaseKey: "otro"` en una tool
- **THEN** el input se rechaza por validación estricta y la consulta, si la hubiera, igual usaría `lang`

### Requirement: Recarga en caliente de usuarios
El repositorio `users.yaml` SHALL releerse cuando cambia su `mtime` y reflejar al instante las escrituras hechas por la API de administración. Un `users.yaml` estructuralmente inválido, o en el formato v1 (sin `version: 2` o con `tokenSha256`), MUST producir `ConfigurationError` al arrancar.

#### Scenario: Baja sin reinicio
- **WHEN** un admin deshabilita a un usuario desde el panel mientras el servidor corre
- **THEN** el siguiente request de ese usuario recibe 403

#### Scenario: Archivo inexistente
- **WHEN** `users.yaml` no existe
- **THEN** el repositorio se comporta como vacío y todo token válido recibe 403

#### Scenario: Archivo del formato anterior
- **WHEN** `users.yaml` tiene registros con `tokenSha256` y no declara `version: 2`
- **THEN** el servidor no arranca e indica que hay que mover el archivo

## REMOVED Requirements

### Requirement: Token Bearer obligatorio
**Reason**: El token opaco con formato `^[A-Za-z0-9_-]{32,256}$` se reemplaza por un access token JWT de Auth0.
**Migration**: Ver "Access token JWT de Auth0 obligatorio". Los clientes quitan el header fijo y negocian OAuth.

### Requirement: Verificación por hash SHA-256
**Reason**: El servidor ya no emite ni guarda credenciales. La verificación pasa a ser criptográfica contra el JWKS del IdP.
**Migration**: Los usuarios se vuelven a dar de alta desde el panel. `users.yaml` v1 se mueve a un backup.
