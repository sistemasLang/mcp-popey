# Proposal

## Why

Hoy cada usuario del MCP tiene un token Bearer estático que un operador genera por consola (`create-user`) y entrega a mano. Eso no escala y tiene varios problemas: el token no vence, rotarlo exige acceso a la VPS, no hay MFA posible, los clientes MCP modernos (Claude, ChatGPT, Codex) esperan descubrir y negociar OAuth por su cuenta, y dar de alta o de baja a alguien depende de quien tenga la consola.

La decisión es delegar la **identidad** en Auth0 (OAuth 2.1 / OIDC) y conservar la **autorización** (rol, `databaseKey`, habilitado) en el repositorio propio del servidor. La gestión de usuarios pasa de la CLI a un panel web de administración. Hay un único mecanismo de autenticación para todos los consumidores: personas y procesos automáticos.

## What Changes

- **BREAKING** `/mcp` deja de aceptar tokens estáticos. Pasa a ser un *OAuth Resource Server*: acepta solo access tokens JWT emitidos por Auth0, con `aud` igual a la URL pública del MCP, verificados localmente contra el JWKS del tenant.
- Nuevo endpoint `/.well-known/oauth-protected-resource` (RFC 9728) y header `WWW-Authenticate` con `resource_metadata` en cada 401, para que los clientes MCP descubran el Authorization Server solos.
- **Personas**: login interactivo (authorization code + PKCE) con email y contraseña en una Database Connection de Auth0, sin registro público. Clientes soportados: Claude (Code, Desktop, web), ChatGPT y Codex, registrados por **CIMD** y aprobados por un admin. DCR queda apagado.
- **Procesos automáticos (n8n)**: grant `client_credentials` con una aplicación M2M de Auth0 por cada cuenta de servicio.
- **Identidad → usuario**: el repositorio de usuarios vincula `(issuer, sub)` con un usuario interno (`id` propio), que conserva `role`, `databaseKey` y `enabled`. `UserContext` no cambia.
- **BREAKING** Se elimina la CLI `create-user` (`dist/cli/create-user.js`), el hash SHA-256 de tokens y `auth-token.ts`. `users.yaml` pasa a un formato nuevo (versión 2).
- Nueva **API de administración** (`/admin/api/*`) protegida por OAuth con una audiencia distinta de la del MCP, y un **panel Angular** (`frontend/`) que la consume. Permite invitar personas, crear cuentas de servicio, asignar rol y tenant, deshabilitar y rotar secretos.
- **Sin mails**: al invitar, el panel muestra una vez un link de Auth0 para que la persona elija su contraseña, y el admin se lo manda por el canal que prefiera. El mismo link se puede regenerar, y eso cubre también "olvidé mi contraseña". No se configura ningún proveedor de email.
- Nuevo puerto outbound `IdentityProviderPort`, con un adapter sobre la Management API de Auth0 (vía `fetch`, sin SDK).
- **Admins**: una cuenta por persona con `admin: true`. El primero se crea a mano en el dashboard de Auth0 y se vincula con `BOOTSTRAP_ADMIN_EMAILS`; los demás se invitan desde el panel. Siempre tiene que quedar al menos un admin habilitado.
- **MFA opcional** para todos, incluidos los admins (decisión explícita del negocio, ver *Impacto en seguridad*).
- Auditoría de cada acción administrativa, con el actor identificado.

## Capabilities

### New Capabilities
- `admin-panel`: API HTTP de administración de usuarios y cuentas de servicio, sus reglas de autorización (solo admins, último admin protegido) y el panel web que la consume.

### Modified Capabilities
- `authentication`: de token estático hasheado a JWT de Auth0 verificado por firma, `iss`, `aud` y `exp`, con metadata de recurso protegido y mapeo `(issuer, sub)` → usuario.
- `user-management`: de CLI y `users.yaml` con hash a panel + `IdentityProviderPort`. Las personas se invitan y las cuentas de servicio se crean como apps M2M.
- `runtime-configuration`: variables de Auth0, URL del recurso MCP, audiencia admin, credenciales de la Management API, bootstrap de admins y rutas nuevas en nginx.
- `audit-logging`: eventos de acciones administrativas y tipo de principal en los eventos de tools.

## Impacto en seguridad

| Barrera | Antes | Después |
|---|---|---|
| Credencial de acceso a `/mcp` | Token estático, hash SHA-256 en `users.yaml`, sin vencimiento | JWT firmado por Auth0 (RS256), `aud` = MCP, vida corta (15 min). Verificación local con JWKS |
| Identidad (`UserContext`) | Sale del registro asociado al hash | Sale del registro asociado a `(issuer, sub)`. Auth0 **no** decide `role` ni `databaseKey` |
| Revocación | `enabled: false` en el próximo request | Igual: `enabled` se chequea en cada request, así que los refresh tokens ya emitidos dejan de servir al instante |
| Gestión de usuarios | **Solo por CLI**; el servidor no exponía endpoints | **Se debilita a propósito**: hay una API HTTP de administración. La cubren la audiencia separada, el chequeo de `admin: true` en el repo propio, inputs Zod strict, la protección del último admin y la auditoría por actor |
| Reenvío de tokens (*token passthrough*) | No aplicaba | Un token del panel (`aud` admin) no sirve en `/mcp`, ni al revés |
| Segundo factor | No existía | **Opcional para todos, incluidos los admins.** Riesgo aceptado por el negocio: una contraseña de admin filtrada permite gestionar usuarios. Lo mitigan el brute-force protection de Auth0, la política de contraseñas, la auditoría y que el rol admin no da acceso al ERP. Pasar a obligatorio es solo configuración de Auth0 |
| Alta de personas | El operador entregaba el token a mano | El admin entrega a mano un link para elegir contraseña, de vida corta (`PASSWORD_LINK_TTL_SECONDS`) y visible una sola vez. Quien lo abre primero se queda con la cuenta, así que el canal de envío importa. Un admin puede regenerar el link de cualquier persona; queda auditado |
| Secreto de alto valor nuevo | — | Credenciales M2M de la Management API en `.env`, con scopes mínimos (ver design.md) |
| Confianza en terceros | Ninguna | Si Auth0 se compromete, se puede suplantar a un usuario **ya provisionado**, pero no crear permisos: `role` y `databaseKey` siguen en el repo propio |

Sin cambios en: solo lectura en PostgreSQL, `QueryCompiler`, grants de `mcp_popey_ro`, aislamiento por tenant, errores seguros y rate limit por `userId`.

## Fuera de alcance

- MFA obligatorio (queda como cambio de configuración futuro).
- Envío de mails (invitación, verificación o recuperación de contraseña) y proveedor de email en Auth0.
- Login social o empresarial (Google, Microsoft) y federación.
- Roles o permisos definidos en Auth0 (RBAC, Actions con lógica de autorización).
- API keys, tokens personales o cualquier credencial estática.
- DCR abierto.
- Migración automática de los usuarios actuales con token: se vuelven a dar de alta desde el panel.
- Autogestión por usuarios comunes (perfil, historial). El panel es solo para admins.
- Rate limit de la API de administración.
- Self-hosting del IdP (Keycloak).

## Impact

- Código nuevo: verificador JWT y metadata de recurso protegido (inbound http), API admin (inbound http), `IdentityProviderPort` y adapter Auth0 (outbound), casos de uso de administración, bootstrap de admins, panel Angular.
- Código modificado: `api/domain/user.ts` y `user-context.ts` (origen de la identidad), `api/application/ports/outbound/user-repository.port.ts`, `api/adapters/outbound/yaml/yaml-user.repository.ts` (formato v2), `api/adapters/inbound/http/http-server.ts`, `api/composition/*`, `api/config/env.ts`, `frontend/src/app/auth/*`.
- Código eliminado: `api/cli/create-user.ts`, `api/adapters/inbound/cli/create-user.cli.ts`, `api/domain/auth-token.ts`, `BearerAuth` por hash y el script `create-user` de `package.json`.
- Dependencias nuevas: `jose` (backend), `angular-oauth2-oidc` (frontend). Justificadas en design.md.
- Infraestructura: tenant de Auth0 configurado (ver design.md), nginx con rutas `/.well-known/oauth-protected-resource*`, `/admin/api/` y el panel estático.
- Documentación: `README.md`, `docs/INSTALACION-VPS.txt`, `openspec/config.yaml` (la identidad ya no sale de un "token Bearer" estático y desaparece la ruta estable de la CLI).
