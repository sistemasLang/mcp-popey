# MCP Popey

Servidor MCP (Node.js + TypeScript) para consultar el ERP Popey en **solo lectura**,
aislado por **tenant**.

```
La IA escribe el SQL. Node.js autentica y decide la base (UserContext).
PostgreSQL garantiza que sea lectura y qué se puede leer (rol mcp_popey_ro).
```

## Tools

| Tool | Input | Qué hace |
|---|---|---|
| `list_circuits` | — | Circuitos del ERP visibles para el rol del usuario |
| `describe_circuit` | `circuit` | Tablas del circuito, qué guarda cada una y sus columnas confirmadas |
| `query_sql` | `sql` | SQL libre de **solo lectura** sobre la base del tenant |

Los circuitos son documentación de negocio para que la IA escriba el SQL; no limitan
qué tablas puede leer un rol.

Los inputs son estrictos: mandar `databaseKey`, `schema`, `host`, `params`, etc. es un
error de validación. Ninguna tool escribe datos.

## Autenticación (OAuth con Auth0)

- `/mcp` es un *OAuth Resource Server*: acepta solo access tokens JWT de Auth0
  (RS256, `iss` exacto, `aud` = `MCP_RESOURCE_URL`, `exp` con 30 s de tolerancia),
  verificados localmente contra el JWKS. No hay tokens estáticos.
- Sin token o con un token inválido: **401** con
  `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
  Los clientes MCP descubren Auth0 desde ahí (RFC 9728) y abren el login solos.
- Token válido pero sin acceso (identidad no dada de alta, deshabilitada o sin rol + tenant):
  **403** `Forbidden`, el mismo mensaje en los tres casos.
- Identidad ≠ autorización: del token solo se toma `(iss, sub)`. El rol, el tenant
  (`databaseKey`), `admin` y `enabled` viven en `data/users.yaml` (formato v2). Ningún claim
  de Auth0 decide permisos. `enabled` se chequea en cada request.
- **Personas** (Claude Code / Desktop / web, ChatGPT, Codex): authorization code + PKCE con
  email y contraseña en Auth0, sin registro público. Clientes registrados por CIMD; DCR apagado.
- **Procesos** (n8n): `client_credentials` con una app M2M de Auth0 por cuenta de servicio.

## Panel de administración

`/admin/` (Angular, `frontend/`) y su API `/admin/api/*`, protegida con OAuth y una audiencia
distinta (`ADMIN_API_AUDIENCE`): un token del panel no sirve en `/mcp` ni al revés. Solo para
personas con `admin: true`.

- **Invitar persona**: no se envía ningún mail. El panel muestra **una vez** un link de Auth0
  para que la persona elija su contraseña, y el admin se lo manda por el canal que elija.
  "Nuevo link" lo regenera (también sirve para "olvidé mi contraseña").
- **Cuenta de servicio**: devuelve `clientId` y `clientSecret` **una vez**; el secreto nunca se
  guarda en el servidor. Se puede rotar.
- Editar rol + tenant, admin y habilitado. Deshabilitar corta el acceso al instante. Siempre
  queda al menos un admin habilitado.
- **Primer admin**: se crea a mano en el dashboard de Auth0 (con su propia contraseña) y se
  vincula al arrancar con `BOOTSTRAP_ADMIN_EMAILS`. El bootstrap solo corre si no hay ningún
  admin habilitado y nunca crea usuarios en Auth0.
- Cada escritura queda en la auditoría (`type: "admin"`) con el actor, sin emails, subjects,
  secretos ni links.

### `query_sql`

- Cualquier lectura: `SELECT`, `WITH`, joins, `GROUP BY`, ventanas, `EXPLAIN`,
  `information_schema`. El servidor no parsea ni reescribe el SQL.
- La lectura la garantiza PostgreSQL: una sola sentencia por llamada (cursor del
  protocolo extendido, así `COMMIT; …` no sale de la transacción), `BEGIN READ ONLY … ROLLBACK`
  y el rol `mcp_popey_ro` solo con `SELECT`.
- Respuesta `{ columns, rows, rowCount, truncated }`. Como máximo `QUERY_SQL_MAX_ROWS`
  filas (default 1000); `truncated: true` avisa que había más (agregar o paginar en SQL).
- Timeout `QUERY_SQL_TIMEOUT_MS` (default 30000 ms). Consume la cuota de rate limit por
  usuario; `list_circuits` y `describe_circuit` no.
- Los errores de SQL traen `diagnostics` (`sqlState`, mensaje, `hint`, `position`) de
  PostgreSQL. Los de conexión siguen siendo genéricos.
- Auditoría: hash SHA-256 y largo del SQL, filas y `truncated`; nunca el texto del SQL.
- Todo rol definido en `circuit-access.yaml` puede usarla y lee todo lo que `mcp_popey_ro`
  puede leer: no hay límite de tablas por rol. Restringir algo se hace con grants en
  `scripts/create_readonly_role.sql`.

## Arquitectura (puertos y adaptadores)

```
api/
  domain/          reglas puras: errores, UserContext, catálogo de circuitos,
                   límites. Sin dependencias externas.
  application/
    ports/inbound  AccessTokenVerifier
    ports/outbound puertos: ReadOnlyDatabasePort, UserRepository, IdentityProviderPort,
                   AuditLogger, RateLimiterPort, InternalErrorLogger
    services/      AuthorizationService, CircuitPolicyService
    use-cases/     AuthenticateUser, AdminUsers, BootstrapAdmins, ListCircuits,
                   DescribeCircuit, QuerySql
  adapters/
    inbound/       http (JWT, metadata RFC 9728, API admin, Streamable HTTP), mcp (tools)
    outbound/      postgres, yaml (circuits, roles, users v2), auth0 (Management API),
                   audit, memory, logging
  composition/     container.ts (cablea puertos ↔ adaptadores), bootstrap.ts (archivos + env)
  config/          lectura y validación del entorno
  index.ts         proceso del servidor (dist/index.js, lo corre pm2)
frontend/          panel de administración (Angular), servido por nginx en /admin/
```

Las dependencias apuntan hacia adentro: `domain` no importa nada externo y
`application` solo `domain` y sus puertos. Solo el adapter `auth0` conoce a Auth0 y solo el
verificador JWT importa `jose`: cambiar de IdP es reconfigurar y reescribir ese adapter.
`test/unit/architecture.test.ts` lo verifica.

## Flujo

```
JWT de Auth0 → JwtAccessTokenVerifier (firma, iss, aud, exp) → (iss, sub)
  → AuthenticateUserUseCase → UserRepository.findByIdentity → UserContext (server-side)
query_sql → Zod ({ sql }) → QuerySqlUseCase: rol definido → RateLimiter
  → ReadOnlyDatabasePort(UserContext.databaseKey) → PostgresDatabaseAdapter → Pool
  → PostgreSQL (BEGIN READ ONLY … ROLLBACK, cursor: una sentencia, maxRows + 1, rol mcp_popey_ro)
```

## Deploy (VPS con nginx + pm2)

Guía completa en `docs/INSTALACION-VPS.txt`. Archivos versionados:
`deploy/pm2/ecosystem.config.cjs` y `deploy/nginx/mcp-popey.conf`.

## Reglas de `circuits.yaml`

`circuits.yaml` es la documentación que `describe_circuit` le da a la IA. `queryable` marca
qué tablas están confirmadas; no es un permiso (`query_sql` no lo consulta).

- Tabla normal → `queryable: true` con sus `key_columns` reales.
- `status` `needs_review` / `legacy` / desconocido → `queryable: false`.
- `key_columns` documentales (`"columnas no confirmadas…"`, `"..."`) se descartan;
  una tabla sin columnas confirmadas queda `queryable: false`.
- `pending_columns` → solo informativas.
- La misma tabla en varios circuitos se evalúa **por circuito**; repetida dentro
  de un circuito se fusiona (si una entrada está restringida, gana la restricción).
- Schema `seguridad` → documentado en el circuito `usuario` (id → nombre/rol). Sus columnas sensibles (password, hashes, 2FA, bloqueo, fecha de nacimiento) no figuran en `key_columns` y el rol `mcp_popey_ro` solo tiene `SELECT` por columna sobre las seguras: esa es la barrera real. `BLOCKED_SCHEMAS` queda vacío, pero el mecanismo sigue activo.
- Un YAML estructuralmente inválido impide arrancar.

## Permisos por rol

`config/circuit-access.yaml` define los roles y qué circuitos ve cada uno en el catálogo.
Todo rol definido ahí puede usar `query_sql`; uno que no figura no accede a nada, y el panel
solo asigna roles definidos. Hoy no hay límite de tablas por rol. Formato en
`config/circuit-access.example.yaml`.

## Uso

```bash
npm install
cp .env.example .env          # credenciales del rol mcp_popey_ro + variables de Auth0
npm run build
npm start                     # http://127.0.0.1:3030/mcp

cd frontend && npm install
cp public/config.example.json public/config.json   # issuer, clientId del SPA, audience admin
npx ng serve                  # panel en http://localhost:4200 (proxy de /admin/api a :3030)
```

Variables de Auth0 (obligatorias salvo indicación):

| Variable | Qué es |
|---|---|
| `AUTH0_DOMAIN` | Dominio del tenant, sin `https://` (`empresa.us.auth0.com`) |
| `MCP_RESOURCE_URL` | URL pública https de `/mcp` = identifier de la API "MCP" en Auth0 |
| `ADMIN_API_AUDIENCE` | Identifier de la API "Admin" (distinto del anterior) |
| `AUTH0_MGMT_CLIENT_ID` / `AUTH0_MGMT_CLIENT_SECRET` | App M2M del servidor para la Management API (scopes mínimos) |
| `AUTH0_DB_CONNECTION` | Opcional, default `Username-Password-Authentication` |
| `BOOTSTRAP_ADMIN_EMAILS` | Opcional: emails (ya creados en Auth0) a vincular como admins en el primer arranque |
| `PASSWORD_LINK_TTL_SECONDS` | Opcional, default 86400 (300 a 604800): vida del link para elegir contraseña |

Si falta una variable, `users.yaml` está en el formato viejo (v1, con tokens) o Auth0 no
responde durante el bootstrap, el servidor no arranca.

Conectarlo a Claude Code (sin header fijo: el cliente negocia OAuth solo):

```bash
claude mcp add --transport http popey https://<DOMINIO>/mcp
# dentro de Claude Code: /mcp → popey → Authenticate
```

## Rol PostgreSQL

Por cada base de tenant:

```bash
psql -U <owner> -d <base> -v ON_ERROR_STOP=1 \
  -v ro_password='<password>' -v owner_role='<owner>' \
  -f scripts/create_readonly_role.sql
```

Otorga solo `CONNECT`, `USAGE` y `SELECT`. En `seguridad` otorga `SELECT` **por columna**,
solo sobre las columnas seguras del circuito `usuario` (sin password, hashes, 2FA, bloqueo
ni fecha de nacimiento). Por eso `SELECT *` sobre esas tablas devuelve `permission denied`.
La lista del script tiene que coincidir con `circuits.yaml`; un test unitario lo verifica.

El script es idempotente: **re-ejecutalo en cada tenant** cada vez que cambie
(por ejemplo, al sumar columnas a `seguridad` o un schema nuevo).

## Tests

```bash
npm test                  # unitarios + e2e MCP por HTTP (sin base)
npm run test:integration  # PostgreSQL efímero con Docker (testcontainers)
```
