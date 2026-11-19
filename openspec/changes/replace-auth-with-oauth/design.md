# Design

## Context

Hoy `BearerAuth` extrae el token, `AuthenticateUserUseCase` valida el formato (`TOKEN_PATTERN`), busca el SHA-256 en `UserRepository.findIdByTokenHash` y construye el `UserContext` (`userId`, `role`, `databaseKey`). La gestión vive en `ManageUsersUseCase`, que solo se invoca desde la CLI y escribe `data/users.yaml` de forma atómica.

Lo que se conserva intacto es la frontera que importa: **las tools solo reciben un `UserContext` construido del lado del servidor**. Este cambio reemplaza cómo se llega a ese `UserContext`, no qué contiene.

Hechos verificados que condicionan el diseño (2026-11-15):

- Auth0 tiene en GA "Auth for MCP": el toggle *Resource Parameter Compatibility Profile* (RFC 8707; si falta `audience` usa `resource`) y el registro de clientes por **CIMD**. Con CIMD, un admin del tenant da de alta la URL del documento de cada cliente y lo aprueba.
- Claude (connectors de web y Desktop, y Claude Code), ChatGPT y Codex soportan CIMD. Claude usa CIMD **solo si la metadata del Authorization Server lo anuncia**; si no, intenta DCR.
- n8n (`McpOAuth2Api.credentials.ts` en master) extiende el credential OAuth2 genérico: con *Register Client Automatically* apagado ofrece *Grant Type: Client Credentials*, y ante un 401 vuelve a pedir el token.
- El SDK MCP del proyecto no trae un middleware de Resource Server para `node:http`, así que la metadata y el 401 se implementan en el adapter HTTP.

Motivación y alcance en proposal.md; comportamiento en `specs/`.

## Goals / Non-Goals

**Goals:**
- Un único mecanismo de autenticación (OAuth con Auth0) para personas y procesos.
- Que dominio y aplicación no conozcan Auth0: todo lo específico del proveedor queda en adapters y config.
- Que cambiar de IdP sea reconfigurar y reescribir un adapter, sin tocar las tools, el `UserContext` ni los casos de uso de consulta.
- Que deshabilitar a alguien corte su acceso al instante, aunque tenga tokens vigentes.

**Non-Goals:**
- Autorización en Auth0 (roles, permisos o Actions con reglas de negocio).
- Credenciales estáticas de cualquier tipo.

## Decisions

### 1. Identidad en Auth0, autorización en el repositorio propio
**Capa: dominio (`User`) + `UserRepository`.**

El usuario tiene un `id` interno (UUID) y una o más identidades externas `{ issuer, subject }`. `role`, `databaseKey`, `admin` y `enabled` viven solo en `users.yaml`.

```yaml
version: 2
users:
  - id: 7c1e…                    # internal id; it is the userId in UserContext and audit
    kind: human                  # human | service
    label: juan@empresa.com      # display only, never used for authorization
    admin: false
    role: ventas                 # role and databaseKey: both or neither
    databaseKey: lang
    enabled: true
    identities:
      - issuer: https://<tenant>.auth0.com/
        subject: auth0|65f…      # service accounts: <client_id>@clients
    createdAt: 2026-11-15T…
```

Reglas del dominio:
- `role` y `databaseKey` van juntos o ninguno. Sin los dos, el usuario no tiene acceso a `/mcp`. Así un admin puede existir sin acceso al ERP.
- `kind: service` MUST NOT tener `admin: true`.
- Un par `(issuer, subject)` pertenece a un solo usuario.

Por qué no usar claims de Auth0 para el rol: te ata al proveedor (Actions propietarias) y le delega a un tercero la decisión de qué base lee cada uno. Por qué no indexar por email: el email cambia y no es único entre IdPs; `(issuer, sub)` sí es estable.

### 2. Verificación JWT local con `jose`
**Capa: adapter inbound http (`JwtAccessTokenVerifier`).**

`jwtVerify` con `createRemoteJWKSet(<issuer>.well-known/jwks.json)` y:
- `algorithms: ['RS256']` fijo (rechaza `none`, `HS256` y cualquier otro).
- `issuer` exacto (`https://${AUTH0_DOMAIN}/`).
- `audience` según la ruta: `MCP_RESOURCE_URL` para `/mcp` y `ADMIN_API_AUDIENCE` para `/admin/api/*`. Esto es lo que impide reenviar tokens entre las dos superficies.
- `exp` y `nbf` con una tolerancia de reloj de 30 s.

El verificador devuelve `{ issuer, subject }`. Un puerto inbound (`AccessTokenVerifier`) permite que los tests usen claves locales (`createLocalJWKSet`) sin red.

Alternativas descartadas:
- *Introspección* en cada request: un viaje a Auth0 por request, y Auth0 no ofrece introspección para access tokens JWT.
- SDK de Auth0 (`express-oauth2-jwt-bearer`): requiere Express y ata el adapter al proveedor.

`jose` no tiene dependencias, es el estándar de facto para JOSE en Node y soporta Node 22 sin polyfills. Es la justificación de la dependencia nueva.

### 3. Flujo de `/mcp`
**Capa: adapter inbound http → `AuthenticateUserUseCase`.**

1. Sin header, header mal formado o JWT inválido (firma, `iss`, `aud`, `exp`, `alg`) → **401** con `WWW-Authenticate: Bearer resource_metadata="<origen>/.well-known/oauth-protected-resource/mcp"`.
2. JWT válido → `findByIdentity(issuer, subject)`. Usuario inexistente, `enabled: false` o sin `role` + `databaseKey` → **403** con el mensaje genérico `Forbidden`. Es el mismo mensaje en los tres casos, para no revelar cuál es.
3. Si pasa → `createUserContext(user)`, igual que hoy.

Por qué 403 y no 401 en el paso 2: el token es válido. Un 401 hace que el cliente MCP repita el login en loop, y un 403 le dice que el problema es de permisos. Esto reemplaza el requisito actual "deshabilitado = 401".

`AuthenticateUserUseCase` recibe `{ issuer, subject }` y ya no conoce tokens. `TOKEN_PATTERN`, `hashToken` y `findIdByTokenHash` desaparecen. Devuelve un `Principal` (`{ context: UserContext, kind }`): `UserContext` no cambia y `kind` solo viaja hasta la auditoría (`principalKind`).

### 4. Metadata de recurso protegido (RFC 9728)
**Capa: adapter inbound http.**

`GET /.well-known/oauth-protected-resource/mcp`, y su alias sin sufijo, responden sin autenticación:

```json
{
  "resource": "<MCP_RESOURCE_URL>",
  "authorization_servers": ["https://<AUTH0_DOMAIN>/"],
  "bearer_methods_supported": ["header"]
}
```

Los clientes leen la metadata del Authorization Server directamente de Auth0. Nginx tiene que enrutar estas rutas al proceso.

### 5. Personas: Database Connection sin registro público
**Capa: configuración de Auth0 + `IdentityProviderPort`.**

- Login con email y contraseña en una Database Connection con *Disable Sign Ups* activado.
- El admin invita desde el panel: `IdentityProviderPort.createHuman(email)` crea el usuario en Auth0 con una contraseña aleatoria que nadie conoce y con `verify_email: false`, para que Auth0 no mande ningún mail. Devuelve el `subject` (`auth0|…`), que se guarda como identidad **en el momento del alta**. Así no hace falta matchear por email en el primer login.
- **Sin mails.** Después del alta, `IdentityProviderPort.issuePasswordLink(subject)` pide un *password change ticket* (`POST /api/v2/tickets/password-change` con `user_id` y `ttl_sec = PASSWORD_LINK_TTL_SECONDS`). Auth0 **devuelve la URL y no envía nada** (verificado en la doc de Auth0, guía *Send email invitations for application sign-up*). El panel muestra la URL una sola vez y el admin se la manda a la persona por el canal que elija. El servidor no la persiste, no la loguea y no la audita.
- El link funciona como una credencial: quien lo abre primero elige la contraseña. Por eso tiene una vida corta y se puede **regenerar** desde el panel (decisión 8). Regenerar es también el camino para "olvidé mi contraseña", porque el tenant no tiene proveedor de email.
- `mark_email_as_verified` queda en `false`: el link no llega por mail, así que no prueba que la persona controle esa casilla.
- MFA: política del tenant en *Never*. Enrolamiento voluntario a definir (ver *Open Questions*).

Alternativa descartada: `/dbconnections/change_password` o un mail con el ticket enviado desde el servidor. Las dos opciones exigen configurar y mantener un proveedor de email (SMTP, SendGrid, etc.), porque el de Auth0 por defecto es solo para pruebas.

### 6. Procesos: cuentas de servicio M2M
**Capa: `IdentityProviderPort` + caso de uso de administración.**

`createServiceAccount(name, role, databaseKey)`:
1. `IdentityProviderPort.createServiceClient(name)` crea en Auth0 una app `non_interactive` con grant `client_credentials` y la autoriza **solo** para la API del MCP (*client grant* con `audience = MCP_RESOURCE_URL`).
2. Guarda el usuario `kind: service` con la identidad `<client_id>@clients`.
3. Devuelve `clientId` y `clientSecret` **una sola vez**. El secreto nunca se persiste en el servidor ni se audita.

`rotateServiceSecret` llama a `rotate-secret` de Auth0. Deshabilitar una cuenta de servicio pone `enabled: false` (corte inmediato) y borra el *client grant* (Auth0 deja de emitir tokens).

En n8n: credential *MCP OAuth2 API*, *Register Client Automatically* apagado, *Grant Type: Client Credentials*, *Access Token URL* `https://<AUTH0_DOMAIN>/oauth/token` y *Resource URL* = `MCP_RESOURCE_URL`.

### 7. `IdentityProviderPort` y adapter Auth0
**Capa: puerto outbound (application) + adapter outbound `auth0`.**

```ts
interface IdentityProviderPort {
  readonly issuer: string;
  createHuman(email: string): Promise<{ subject: string }>;
  issuePasswordLink(subject: string): Promise<{ url: string; expiresAt: Date }>;
  findHumanByEmail(email: string): Promise<{ subject: string } | null>;
  setHumanBlocked(subject: string, blocked: boolean): Promise<void>;
  createServiceClient(name: string): Promise<{ subject: string; clientId: string; clientSecret: string }>;
  rotateServiceSecret(subject: string): Promise<{ clientId: string; clientSecret: string }>;
  revokeServiceClient(subject: string): Promise<void>;
  restoreServiceClient(subject: string): Promise<void>;
}
```

Los métodos de cuentas de servicio reciben el `subject` y no el `client_id`: el formato `<client_id>@clients` es de Auth0 y solo el adapter lo conoce. `restoreServiceClient` vuelve a crear el *client grant* al rehabilitar una cuenta de servicio (sin él, Auth0 no emitiría tokens aunque `enabled` sea `true`).

El adapter usa `fetch` contra la Management API v2 con un token M2M propio (`AUTH0_MGMT_CLIENT_ID`/`SECRET`), cacheado hasta su `exp`. Scopes mínimos: `read:users`, `create:users`, `update:users`, `create:user_tickets`, `read:clients`, `create:clients`, `update:client_keys`, `read:client_grants`, `create:client_grants`, `delete:client_grants`. `read:client_grants` hace falta para encontrar el grant que se borra al deshabilitar. Los errores del proveedor se traducen a un `IdentityProviderError` sin cuerpo de respuesta ni credenciales.

Orden y compensación: primero Auth0, después el repo. Si falla la escritura del repo, el caso de uso intenta deshacer en Auth0 (bloquear al usuario o revocar el cliente) y registra el error interno. Un huérfano en Auth0 no da acceso, porque sin registro propio no hay `UserContext`.

En la invitación el orden es `createHuman` → guardar en el repo → `issuePasswordLink`. Si falla solo el ticket, el usuario queda creado y la API responde un error que lo indica, para que el admin regenere el link. No hace falta compensar, porque sin contraseña conocida nadie puede entrar.

Sin SDK de Auth0: son pocos endpoints, `fetch` es nativo en Node 22 y no suma dependencias.

### 8. API de administración
**Capa: adapter inbound http (`/admin/api/*`) → casos de uso `AdminUsersUseCase`.**

Autenticación: JWT con `aud = ADMIN_API_AUDIENCE` → usuario por identidad → `kind: human`, `enabled: true` y `admin: true`. Si falla algo después de verificar el token → 403.

| Método y ruta | Acción |
|---|---|
| `GET /admin/api/catalog` | Roles de `circuit-access.yaml` y `DATABASE_KEYS`, para los selectores del panel |
| `GET /admin/api/users` | Lista de usuarios (sin identidades crudas, con `kind`, `label`, `admin`, `role`, `databaseKey`, `enabled`) |
| `POST /admin/api/users` | Invita a una persona: `{ email, admin?, role?, databaseKey? }` → usuario + `passwordLink: { url, expiresAt }` una vez |
| `POST /admin/api/users/:id/password-link` | Nuevo link para elegir contraseña, una vez. Solo personas habilitadas |
| `PATCH /admin/api/users/:id` | Cambia `admin`, `role` + `databaseKey` o `enabled` |
| `POST /admin/api/service-accounts` | Crea una cuenta de servicio: `{ name, role, databaseKey }` → secreto una vez |
| `POST /admin/api/service-accounts/:id/rotate-secret` | Nuevo secreto, una vez |

Reglas:
- Bodies validados con Zod strict. `role` tiene que existir en `circuit-access.yaml` y `databaseKey` en `DATABASE_KEYS`, igual que validaba la CLI.
- **Último admin**: se rechaza cualquier cambio que deje cero admins habilitados (deshabilitarlo o quitarle `admin`), incluido el admin sobre sí mismo.
- Deshabilitar a una persona: `enabled: false` en el repo (corte inmediato) y `setHumanBlocked(true)` en Auth0.
- Todas las respuestas de la API admin llevan `Cache-Control: no-store` (en particular las que traen un link o un secreto).
- Respuestas parciales: si la invitación crea al usuario pero falla el link, responde 201 con `passwordLink: null` y `passwordLinkError`. Si una baja se guarda pero Auth0 falla, responde 200 con `warning: "IDENTITY_PROVIDER_SYNC_FAILED"`.
- Errores: body inválido → 400 (y se audita el rechazo), usuario inexistente → 404, conflicto (duplicado, último admin, deshabilitado) → 409, falla de Auth0 → 502 sin detalles.
- Pedir un link para una cuenta de servicio → 400. Pedirlo para una persona deshabilitada → 409.
- Sin cookies: el token viaja en `Authorization`, así que no hay CSRF. El panel se sirve desde el mismo origen, así que no se emiten headers CORS.

### 9. Bootstrap de admins
**Capa: caso de uso `BootstrapAdminsUseCase` (application), invocado desde composition (`bootstrap.ts`) antes de abrir el puerto.**

Si al arrancar **no hay ningún admin habilitado** y `BOOTSTRAP_ADMIN_EMAILS` tiene valores, por cada email el servidor hace `findHumanByEmail` y crea el usuario con `admin: true` y sin acceso a `/mcp`. **El bootstrap solo vincula, nunca crea usuarios en Auth0.** Si un email no existe en Auth0, el arranque falla y el mensaje pide crearlo primero en el dashboard.

Por qué: crear en Auth0 obligaría a generar un link sin panel donde mostrarlo, y la única salida sería el log, que no es lugar para una credencial. El primer admin se crea a sí mismo en el dashboard de Auth0 (*User Management > Users > Create User*, en la Database Connection) con su propia contraseña. *Disable Sign Ups* no lo impide, porque solo bloquea el registro público. Quien tiene acceso al dashboard de Auth0 ya es, en la práctica, superadmin.

Recomendación: poner **solo el email propio** en `BOOTSTRAP_ADMIN_EMAILS` y dar de alta al resto de los admins desde el panel con `admin: true`. Así nadie elige la contraseña de otro.

Si ya hay un admin, la variable se ignora. Así un `.env` viejo no puede volver a crear admins después de una baja. Si Auth0 no responde durante el bootstrap, el arranque falla (fail-fast).

### 10. Panel Angular
**Capa: `frontend/`.**

- `angular-oauth2-oidc` con authorization code + PKCE (cliente público, sin secreto) contra una app *Single Page Application* de Auth0, con `audience = ADMIN_API_AUDIENCE`. Es una librería OIDC genérica, para no atarse a `@auth0/auth0-angular`.
- `auth.service.ts` deja de postear usuario y contraseña a `/api/login`: el login es una redirección a Auth0 y la contraseña nunca pasa por el panel. `auth.interceptor.ts` agrega el access token solo a `/admin/api/`. `rol.guard.ts` y `jwt-helper.ts` quedan solo para UX: la autorización real la hace la API.
- El panel se sirve como estático por nginx en `/admin/`. Su config pública (dominio de Auth0, client id del SPA, audiencia) va en un `config.json` en runtime, no compilada.

### 11. `users.yaml` v2 y corte duro
**Capa: adapter outbound yaml.**

El repositorio lee y escribe `version: 2` con la escritura atómica y permisos `0600` actuales, y conserva la relectura por `mtime`. Si encuentra un archivo sin `version` o con `tokenSha256` (formato v1), el arranque **falla** con un mensaje que pide moverlo de lugar. Así un archivo viejo nunca se interpreta en silencio como vacío o válido.

## Configuración de Auth0 (fuera del código)

- **APIs**: *MCP* con identifier = `MCP_RESOURCE_URL`, RS256, vida del token 900 s y *Allow Offline Access* activado (los clientes MCP guardan refresh tokens). *Admin* con identifier = `ADMIN_API_AUDIENCE` y vida del token 900 s.
- **Tenant (Settings > Advanced)**: *Client ID Metadata Document Registration* activado, *Dynamic Client Registration* apagado y *Resource Parameter Compatibility Profile* activado.
- **Database Connection**: *Disable Sign Ups*, política de contraseñas *Good* o superior, brute-force protection activado y habilitada para las apps de Claude, ChatGPT, Codex y el SPA del panel.
- **Email**: no se configura ningún proveedor. Ningún flujo del diseño depende de que Auth0 mande mails.
- **Primer admin**: creado a mano en *User Management > Users* (decisión 9).
- **Clientes CIMD**: un admin registra y aprueba la URL de metadata de cada cliente (por ejemplo la de Codex, `https://chatgpt.com/oauth/codex/client.json`).
- **Management API**: una app M2M para el servidor, solo con los scopes de la decisión 7.

## Risks / Trade-offs

- **[Admin sin MFA]** → Mitigado por brute-force protection, política de contraseñas, auditoría por actor y separación de audiencias. Aceptado explícitamente en proposal.md.
- **[Auth0 caído]** → Nadie puede loguearse ni renovar tokens, pero los access tokens vigentes siguen sirviendo hasta 15 min, porque la verificación es local con el JWKS cacheado.
- **[Expiración del refresh token de los clientes MCP]** → Las personas vuelven a loguearse. Es aceptable. n8n no se ve afectado, porque `client_credentials` no usa refresh token.
- **[Link de contraseña interceptado]** → Quien lo abra primero se queda con la cuenta. Mitigado por la vida corta (`PASSWORD_LINK_TTL_SECONDS`), porque se muestra una sola vez y porque la persona se da cuenta si al abrirlo ya fue usado. El admin elige el canal de envío.
- **[Un admin puede tomar cualquier cuenta humana]** → Regenerar el link le permite fijar la contraseña de otra persona. Es inherente a que los admins gestionan usuarios. Queda auditado (`issue_password_link`).
- **["Olvidé mi contraseña" de Auth0]** → Sin proveedor de email propio ese flujo no es confiable, así que se desactiva en la Database Connection. El camino soportado es pedirle a un admin un link nuevo.
- **[Secreto de la Management API filtrado]** → Permite crear usuarios en Auth0, pero no darles acceso al ERP sin escribir `users.yaml`. Se mitiga con scopes mínimos y rotación.
- **[Lock-in]** → Acotado: `jose` y `angular-oauth2-oidc` son genéricos, la autorización es propia y solo el adapter de `IdentityProviderPort` conoce Auth0. Exportar hashes de contraseñas requiere soporte de Auth0 (costo aceptado).

## Migration Plan

1. Configurar el tenant de Auth0 (sección anterior) y cargar las variables nuevas en `.env`.
2. Crear el usuario del primer admin en el dashboard de Auth0, con su propia contraseña.
3. Desplegar la versión nueva con `BOOTSTRAP_ADMIN_EMAILS=<email del primer admin>`, después de mover `data/users.yaml` v1 a un backup.
4. El primer admin entra al panel, invita a los demás admins y a las personas, y les manda el link a cada uno. Después crea la cuenta de servicio de n8n.
5. Reconfigurar los clientes: quitar el header `Authorization` fijo de las configs MCP (con un header fijo, Claude no intenta OAuth), agregar el connector por URL y configurar el credential de n8n.

Rollback: volver a la imagen anterior y restaurar el backup de `users.yaml` v1. Los tokens estáticos viejos siguen siendo válidos para esa versión.

## Open Questions

- **"Olvidé mi contraseña" en Universal Login**: resuelto (2026-11-15). New Universal Login permite desactivar la recuperación self-service por conexión (`forgot_password_enabled`). Se desactiva en la Database Connection (guía de la VPS, 6.1 d). Falta confirmar el nombre exacto del toggle en el dashboard.
- **MFA voluntario**: falta confirmar cómo ofrecer el enrolamiento opcional en Auth0 (Post-Login Action que pide MFA a quien ya enroló, más un punto de enrolamiento). El MVP puede arrancar con la política *Never*.
- **Audiencia en n8n**: falta confirmar que n8n envíe el *Resource URL* en `client_credentials`. Si no lo envía, configurar `MCP_RESOURCE_URL` como *Default Audience* del tenant.
- **Versiones**: confirmar que la instancia de n8n del usuario tiene el credential MCP OAuth2 con *Grant Type*. Resuelto para el resto (2026-11-15): `jose@6.2.17` (sin dependencias, Web Crypto nativo de Node 22) y `angular-oauth2-oidc@21.0.3` (peer `@angular/core >=21`; la 22.x ya pide Angular 22).
