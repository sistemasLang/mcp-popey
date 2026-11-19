# Tasks

## 0. Verificaciones previas (Open Questions de design.md)

- [x] 0.1 Confirmar en la doc de Auth0 cómo se envía el mail de invitación y elegir el mecanismo. Decisión: *password change ticket* sin mails; el ticket devuelve la URL y Auth0 no envía nada (design.md, decisión 5)
- [x] 0.4 Confirmar si Universal Login permite ocultar el link "Olvidé mi contraseña"; si se puede, documentarlo en la guía del tenant
- [x] 0.2 Confirmar que `angular-oauth2-oidc` soporta Angular 21 y que `jose` funciona en Node 22 sin polyfills; registrar las versiones elegidas en design.md
- [ ] 0.3 Confirmar en la instancia de n8n que el credential *MCP OAuth2 API* ofrece *Grant Type: Client Credentials* y si envía el *Resource URL*; si no lo envía, documentar el uso de *Default Audience* en Auth0

## 1. Dominio y puertos

- [x] 1.1 Reescribir `api/domain/user.ts`: `User` con `id`, `kind`, `label`, `admin`, `enabled`, `role?` + `databaseKey?` (ambos o ninguno), `identities: { issuer, subject }[]` y `createdAt`; funciones puras de validación (rol sin tenant, servicio admin, identidad duplicada); tests unitarios de cada regla con su escenario de rechazo; verificar con `npm test`
- [x] 1.2 Ajustar `api/domain/user-context.ts`: `createUserContext` exige `role` y `databaseKey` y usa el `id` interno; test unitario de que nunca toma el `subject`; verificar con `npm test`
- [x] 1.3 Redefinir `UserRepository` (`findByIdentity(issuer, subject)`, `findById`, `list`) y `UserAdminRepository` (`save`, `findByLabel`, `countEnabledAdmins`) en `api/application/ports/outbound/user-repository.port.ts`; agregar `IdentityProviderPort` (design.md, decisión 7) y el puerto inbound `AccessTokenVerifier`; verificar con `npm run typecheck`
- [x] 1.4 Eliminar `api/domain/auth-token.ts`, `TOKEN_PATTERN`, `hashToken` y `findIdByTokenHash`; verificar con `npm run typecheck` sin referencias colgadas

## 2. Persistencia `users.yaml` v2

- [x] 2.1 Reescribir `api/adapters/outbound/yaml/yaml-user.repository.ts` con el schema v2 (Zod strict, `version: 2`), escritura atómica, permisos `0600` y relectura por `mtime`; rechazar el formato v1 con `ConfigurationError`; tests unitarios de lectura y escritura, archivo inexistente, v1 rechazado y relectura; verificar con `npm test`
- [x] 2.2 Actualizar `api/adapters/outbound/memory/in-memory-user.repository.ts` con la misma interfaz para los tests; verificar con `npm run typecheck`

## 3. Verificación de tokens y `/mcp`

- [x] 3.1 Agregar `jose` a `package.json` e implementar `JwtAccessTokenVerifier` (RS256 fijo, `iss` exacto, `aud` por superficie, tolerancia de 30 s, JWKS remoto); tests unitarios con `generateKeyPair` + `createLocalJWKSet`: válido, firma ajena, `alg: none`, `HS256`, vencido, `iss` ajeno y `aud` cruzado; verificar con `npm test`
- [x] 3.2 Reescribir `AuthenticateUserUseCase` para recibir `{ issuer, subject }` y devolver `UserContext`, o `ForbiddenError` genérico si no hay identidad, está deshabilitado o no tiene rol; tests unitarios de los tres casos con el mismo mensaje; verificar con `npm test`
- [x] 3.3 Reemplazar `BearerAuth` y actualizar `api/adapters/inbound/http/http-server.ts`: 401 con `WWW-Authenticate: Bearer resource_metadata=…`, 403 genérico y las rutas `/.well-known/oauth-protected-resource[/mcp]` (solo GET); verificar con `npm run typecheck`
- [x] 3.4 Adaptar `test/e2e-harness.ts` para firmar JWT con una clave local e inyectar el verificador; tests e2e en `test/unit/mcp.e2e.test.ts`: sin token → 401 con `resource_metadata`, token estático viejo → 401, token del panel en `/mcp` → 401, identidad no provisionada → 403, deshabilitado con token vigente → 403, admin sin rol → 403, claim `role` inyectado ignorado, cuenta de servicio OK, metadata sin auth y `POST` a metadata → 405; verificar con `npm test`

## 4. Proveedor de identidad (Auth0)

- [x] 4.1 Implementar `api/adapters/outbound/auth0/auth0-identity-provider.adapter.ts` con `fetch` contra la Management API: token M2M cacheado hasta `exp`, `createHuman` (contraseña aleatoria y `verify_email: false`), `issuePasswordLink` (`POST /api/v2/tickets/password-change` con `user_id`, `ttl_sec` y `mark_email_as_verified: false`), `findHumanByEmail`, `setHumanBlocked`, `createServiceClient` (app `non_interactive` + client grant solo a `MCP_RESOURCE_URL`), `rotateServiceSecret` y `revokeServiceClient`; errores a `IdentityProviderError` sin cuerpo ni credenciales; tests unitarios con un `fetch` falso que verifiquen URLs, bodies (incluido `verify_email: false`) y que ni los errores ni los logs filtren secretos o la URL del ticket; verificar con `npm test`
- [x] 4.2 Agregar un `FakeIdentityProvider` en `api/adapters/outbound/memory/` para e2e; verificar con `npm run typecheck`

## 5. Casos de uso de administración

- [x] 5.1 Reemplazar `ManageUsersUseCase` por `AdminUsersUseCase`: invitar persona (`createHuman` → repo → `issuePasswordLink`), regenerar link, actualizar (`admin`, `role` + `databaseKey`, `enabled`), crear cuenta de servicio, rotar secreto; validación de rol y tenant antes del IdP; regla de último admin; orden IdP → repo con compensación; tests unitarios de cada escenario de `user-management` y `admin-panel` (incluidos email duplicado, falla al guardar con compensación, falla del link con usuario creado, link para servicio o deshabilitado rechazado, IdP caído en la baja y servicio admin rechazado); verificar con `npm test`
- [x] 5.2 Implementar el bootstrap de admins en `api/composition/bootstrap.ts` según design.md (decisión 9), solo con `findHumanByEmail` (nunca crea en el IdP ni emite links); tests unitarios: primer despliegue, email inexistente en el IdP → error sin escribir `users.yaml`, variable ignorada si hay admin habilitado e IdP caído → error; verificar con `npm test`
- [x] 5.3 Extender `AuditEvent` con `principalKind` y agregar `AdminAuditEvent` (`type: "admin"`); acción `issue_password_link`; tests unitarios de que los eventos no contienen email, `subject`, secretos, tokens ni la URL del link; verificar con `npm test`

## 6. API de administración HTTP

- [x] 6.1 Implementar `api/adapters/inbound/http/admin-api.ts` con las rutas de design.md (decisión 8), schemas Zod strict, autenticación con `aud` admin y chequeo `kind: human` + `admin` + `enabled`; mapear errores a 400, 401, 403, 404 y 409 sin detalles internos; `Cache-Control: no-store` en las respuestas con link o secreto; verificar con `npm run typecheck`
- [x] 6.2 Tests e2e de la API admin con `FakeIdentityProvider`: sin token → 401, token MCP → 401, persona no admin → 403, propiedad extra → 400, último admin → 409, alta de cuenta de servicio devuelve el secreto una vez y `users.yaml` no lo contiene, invitación y regeneración devuelven `passwordLink` con `no-store` y `users.yaml` no lo contiene, el listado no expone `subject`, y cada escritura genera su evento de auditoría; verificar con `npm test`

## 7. Configuración y composición

- [x] 7.1 Agregar a `api/config/env.ts` las variables `AUTH0_DOMAIN`, `MCP_RESOURCE_URL` (https), `ADMIN_API_AUDIENCE`, `AUTH0_MGMT_CLIENT_ID`, `AUTH0_MGMT_CLIENT_SECRET`, `AUTH0_DB_CONNECTION`, `BOOTSTRAP_ADMIN_EMAILS` y `PASSWORD_LINK_TTL_SECONDS`; tests en `test/unit/config.test.ts` de defaults, faltantes, `http://` rechazado, TTL fuera de rango y mensajes sin valores de secretos; verificar con `npm test`
- [x] 7.2 Cablear verificador, adapter Auth0, casos de uso y API admin en `api/composition/container.ts`; extender `test/unit/architecture.test.ts` para que `domain` y `application` no importen `jose` ni el adapter `auth0`; verificar con `npm test`
- [x] 7.3 Eliminar `api/cli/create-user.ts`, `api/adapters/inbound/cli/create-user.cli.ts` y el script `create-user` de `package.json`; verificar con `npm run build` sin `dist/cli/`

## 8. Panel Angular

- [x] 8.1 Agregar `angular-oauth2-oidc` y reescribir `frontend/src/app/auth/auth.service.ts` con code + PKCE contra Auth0 (`audience` admin) y config pública cargada en runtime desde `config.json`; eliminar el login por usuario y contraseña; verificar con `ng build`
- [x] 8.2 Ajustar `auth.interceptor.ts` para adjuntar el token solo a `/admin/api/`, y `auth.guard.ts`, `rol.guard.ts` y `jwt-helper.ts` como guards de UX; tests de que el interceptor no adjunta el token a otros orígenes; verificar con `ng test`
- [ ] 8.3 Páginas: listado de usuarios, invitar persona, regenerar link, editar rol/tenant/admin/habilitado, crear cuenta de servicio y rotar secreto (el link y el secreto se muestran una vez, con vencimiento y botón de copiar, y no se guardan); verificar con `ng build` y una prueba manual contra un tenant de desarrollo

## 9. Infraestructura

- [x] 9.1 Actualizar `deploy/nginx/mcp-popey.conf` con las rutas `/.well-known/oauth-protected-resource[/mcp]`, `/admin/api/` y el estático `/admin/`, con 404 para el resto; verificar con `nginx -t` en la VPS (validado con `nginx -t` y ruteo del panel en un contenedor nginx:1.27; falta en la VPS real)
- [ ] 9.2 Actualizar `.env.example`, `compose.yaml`, `Dockerfile` y `deploy/pm2/ecosystem.config.cjs` con las variables nuevas, sin referencias a la CLI; verificar con `docker compose config`
- [ ] 9.3 Documentar en `docs/INSTALACION-VPS.txt` la configuración del tenant de Auth0 (APIs, toggles de CIMD/DCR/Resource Parameter, Database Connection, registro de clientes CIMD, app M2M de la Management API, sin proveedor de email) y la migración (backup de `users.yaml` v1, crear el primer admin en el dashboard de Auth0, bootstrap con su email, quitar headers fijos de los clientes, credential de n8n); verificar siguiendo la guía en un tenant de desarrollo

## 10. Documentación y cierre

- [x] 10.1 Actualizar `README.md`: flujo de autenticación OAuth, clientes soportados, panel de administración, variables nuevas y eliminación de la CLI; verificar que no quedan referencias a `create-user` ni a tokens estáticos con `rg -n "create-user|tokenSha256" README.md docs`
- [x] 10.2 Actualizar `openspec/config.yaml`: el `UserContext` sale de un access token de Auth0 mapeado por `(issuer, sub)`, desaparece la ruta estable `dist/cli/create-user.js` y se describe la API admin como superficie autenticada; verificar con `openspec validate --all --strict`
- [x] 10.3 Correr `npm run typecheck`, `npm test` y `npm run test:integration`, y que los tres queden en verde
