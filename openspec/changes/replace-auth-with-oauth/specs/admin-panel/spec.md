# Spec Delta

## ADDED Requirements

### Requirement: API de administración solo para admins
Toda ruta bajo `/admin/api/` SHALL exigir un access token JWT válido con `aud` = `ADMIN_API_AUDIENCE`, cuyo `(iss, sub)` esté vinculado a un usuario `kind: human` con `enabled: true` y `admin: true`. Un token inválido MUST responder 401. Un token válido de un usuario que no cumple esas condiciones MUST responder 403 con el mensaje genérico `Forbidden`.

#### Scenario: Usuario común en la API admin
- **WHEN** una persona sin `admin: true` llama a `GET /admin/api/users` con un token válido de la audiencia admin
- **THEN** recibe 403 y no se lee el repositorio de usuarios para responder

#### Scenario: Admin deshabilitado
- **WHEN** un admin con `enabled: false` usa un token todavía vigente
- **THEN** recibe 403

#### Scenario: Sin token
- **WHEN** se llama a `POST /admin/api/users` sin header `Authorization`
- **THEN** recibe 401 y no se llama al IdP

### Requirement: Operaciones de administración
La API SHALL ofrecer: `GET /admin/api/catalog`, `GET /admin/api/users`, `POST /admin/api/users` (invitar persona), `POST /admin/api/users/:id/password-link` (nuevo link para elegir contraseña), `PATCH /admin/api/users/:id` (`admin`, `role` + `databaseKey`, `enabled`), `POST /admin/api/service-accounts` y `POST /admin/api/service-accounts/:id/rotate-secret`. Las respuestas que traen un link o un secreto MUST llevar `Cache-Control: no-store`.

#### Scenario: Respuesta con link
- **WHEN** un admin invita a una persona o regenera su link
- **THEN** la respuesta trae `passwordLink` y el header `Cache-Control: no-store`

#### Scenario: Catálogo para el panel
- **WHEN** un admin pide `GET /admin/api/catalog`
- **THEN** recibe los roles de `circuit-access.yaml` y las claves de `DATABASE_KEYS`, sin datos de conexión

#### Scenario: Usuario inexistente
- **WHEN** un admin envía `PATCH /admin/api/users/<id-que-no-existe>`
- **THEN** recibe 404 y no se llama al IdP

### Requirement: Entradas estrictas y respuestas sin datos sensibles
Los bodies de la API admin MUST validarse con schemas Zod strict que rechacen propiedades extra. Las respuestas MUST NOT incluir identidades crudas del IdP, tokens ni secretos, salvo el secreto recién emitido de una cuenta de servicio o el link recién emitido para elegir contraseña.

#### Scenario: Propiedad extra en el body
- **WHEN** un admin envía `POST /admin/api/users` con `{ "email": "a@b.com", "identities": [...] }`
- **THEN** recibe 400 y no se crea nada

#### Scenario: Listado sin datos sensibles
- **WHEN** un admin pide `GET /admin/api/users`
- **THEN** cada usuario trae `id`, `kind`, `label`, `admin`, `role`, `databaseKey` y `enabled`, sin `subject` ni secretos

### Requirement: Siempre queda un admin habilitado
La API SHALL rechazar, con 409, cualquier operación que deje cero usuarios con `admin: true` y `enabled: true`, incluido que un admin se deshabilite o se quite `admin` a sí mismo.

#### Scenario: Último admin se deshabilita
- **WHEN** el único admin habilitado envía `PATCH` sobre su propio usuario con `enabled: false`
- **THEN** recibe 409 y sigue habilitado

#### Scenario: Hay otro admin
- **WHEN** hay dos admins habilitados y uno le quita `admin` al otro
- **THEN** la operación se aplica

### Requirement: Bootstrap de admins
Al arrancar, si no hay ningún usuario con `admin: true` y `enabled: true`, el servidor SHALL tomar `BOOTSTRAP_ADMIN_EMAILS` y, para cada email, buscar al usuario existente en el IdP y vincularlo como admin `kind: human`, sin `role` ni `databaseKey`. El bootstrap MUST NOT crear usuarios en el IdP ni emitir links. Si un email no existe en el IdP, o si el IdP falla, el arranque MUST fallar. Si ya existe un admin habilitado, la variable MUST ignorarse.

#### Scenario: Primer despliegue
- **WHEN** `users.yaml` no existe, `ana@empresa.com` ya fue creada en el dashboard de Auth0 y `BOOTSTRAP_ADMIN_EMAILS=ana@empresa.com`
- **THEN** Ana queda como admin sin acceso a `/mcp` y entra al panel con la contraseña que eligió en Auth0

#### Scenario: Email que no existe en el IdP
- **WHEN** `BOOTSTRAP_ADMIN_EMAILS` incluye un email sin usuario en Auth0
- **THEN** el arranque falla con un mensaje que pide crearlo en el dashboard, no se crea nada en el IdP y no se escribe `users.yaml`

#### Scenario: Variable vieja después de una baja
- **WHEN** hay un admin habilitado y `BOOTSTRAP_ADMIN_EMAILS` incluye a una persona que fue deshabilitada
- **THEN** no se crea ni se rehabilita a nadie

### Requirement: Panel web de administración
El panel (`frontend/`) SHALL autenticar con authorization code + PKCE como cliente público contra Auth0, pidiendo `audience` = `ADMIN_API_AUDIENCE`, y enviar el access token solo a `/admin/api/`. El panel MUST NOT recibir, transmitir ni guardar contraseñas. Los guards de rol del panel son solo de experiencia de usuario: la autorización la decide la API.

#### Scenario: Login
- **WHEN** un admin abre el panel sin sesión
- **THEN** es redirigido a Auth0 y, al volver, el panel tiene un access token de la audiencia admin

#### Scenario: Guard manipulado en el navegador
- **WHEN** alguien sin `admin: true` fuerza la ruta de usuarios en el panel
- **THEN** las llamadas a `/admin/api/` reciben 403 y no se muestran datos

#### Scenario: Secreto de cuenta de servicio
- **WHEN** el panel crea una cuenta de servicio
- **THEN** muestra el `clientSecret` una sola vez con aviso de copiarlo, y no lo guarda en el navegador

#### Scenario: Link de invitación
- **WHEN** el panel invita a una persona o regenera su link
- **THEN** muestra la URL una sola vez, con su vencimiento y un botón para copiarla, y no la guarda en el navegador
