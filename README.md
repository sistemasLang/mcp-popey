# MCP Popey

Servidor MCP (Node.js + TypeScript) para consultar el ERP Popey en **solo lectura**,
acotado por **rol** y aislado por **tenant**.

```
La IA solicita. Node.js valida y autoriza. El QueryCompiler decide el SQL.
UserContext decide la base. PostgreSQL aplica la última barrera de solo lectura.

query_sql (opt-in por rol): la IA escribe el SQL; PostgreSQL garantiza que sea lectura.
```

## Tools

| Tool | Input | Qué hace |
|---|---|---|
| `list_circuits` | — | Circuitos permitidos para el rol del usuario |
| `describe_circuit` | `circuit` | Tablas, si son consultables y sus columnas permitidas |
| `query_circuit` | `circuit, table, select, filters?, orderBy?, limit?` | Lectura vía DSL; el servidor compila el SQL |
| `query_sql` | `sql` | SQL libre de **solo lectura**. Solo para roles con `sql: true` |

Los inputs son estrictos: mandar `databaseKey`, `schema`, `host`, `params`, etc. es un
error de validación. Ninguna tool escribe datos.

### `query_sql`

- Cualquier lectura: `SELECT`, `WITH`, joins, `GROUP BY`, ventanas, `EXPLAIN`,
  `information_schema`. El servidor no parsea ni reescribe el SQL.
- La lectura la garantiza PostgreSQL: una sola sentencia por llamada (cursor del
  protocolo extendido, así `COMMIT; …` no sale de la transacción), `BEGIN READ ONLY … ROLLBACK`
  y el rol `mcp_popey_ro` solo con `SELECT`.
- Respuesta `{ columns, rows, rowCount, truncated }`. Como máximo `QUERY_SQL_MAX_ROWS`
  filas (default 1000); `truncated: true` avisa que había más (agregar o paginar en SQL).
- Timeout propio `QUERY_SQL_TIMEOUT_MS` (default 30000 ms). Comparte cuota de rate limit
  con `query_circuit`.
- Los errores de SQL traen `diagnostics` (`sqlState`, mensaje, `hint`, `position`) de
  PostgreSQL. Los de conexión siguen siendo genéricos.
- Auditoría: hash SHA-256 y largo del SQL, filas y `truncated`; nunca el texto del SQL.
- Los permisos por circuito **no** acotan a `query_sql`: un rol habilitado lee todo lo que
  `mcp_popey_ro` puede leer.

Operadores de filtro: `eq neq gt gte lt lte in contains startsWith isNull isNotNull`.

## Flujo

```
Bearer token → TokenVerifier → UserRepository → UserContext (server-side)
query_circuit → Zod (estructura) → RateLimiter → QueryValidator (autorización)
  → QueryCompiler (SQL parametrizado) → QueryExecutor(UserContext.databaseKey)
  → DatabaseAdapter → Pool → PostgreSQL (BEGIN READ ONLY … ROLLBACK, rol mcp_popey_ro)
query_sql → Zod ({ sql }) → RateLimiter → SqlExecutor(UserContext.databaseKey)
  → DatabaseAdapter (cursor: una sentencia, maxRows + 1) → PostgreSQL (mismas barreras)
```

## Reglas de `circuits.yaml`

- Tabla normal → consultable con sus `key_columns` reales.
- `status` `needs_review` / `legacy` / desconocido → **no** consultable (deny by default).
- `key_columns` documentales (`"columnas no confirmadas…"`, `"..."`) se descartan;
  una tabla sin columnas confirmadas no es consultable.
- `pending_columns` → solo informativas, nunca seleccionables/filtrables/ordenables.
- La misma tabla en varios circuitos se evalúa **por circuito**; repetida dentro
  de un circuito se fusiona (si una entrada está restringida, gana la restricción).
- Schema `seguridad` → consultable a propósito solo por el circuito `usuario` (id → nombre/rol). Sus columnas sensibles (password, hashes, 2FA, bloqueo, fecha de nacimiento) no figuran en `key_columns` y el rol `mcp_popey_ro` solo tiene `SELECT` por columna sobre las seguras. `BLOCKED_SCHEMAS` queda vacío, pero el mecanismo sigue activo.
- Un YAML estructuralmente inválido impide arrancar.

## Permisos por rol

`config/circuit-access.yaml` define, por rol, sus circuitos y si puede usar `query_sql`
(`sql: true`, default `false`). Los permisos de Popey los define el negocio. Un rol que
no figura no accede a nada, y la CLI solo crea usuarios con roles definidos. Formato en
`config/circuit-access.example.yaml`.

## Uso

```bash
npm install
cp .env.example .env          # completar credenciales del rol mcp_popey_ro
npm run build
npm start                     # http://127.0.0.1:3000/mcp
```

Usuarios (solo por consola; el token se muestra una vez, se guarda su SHA-256):

```bash
node dist/cli/create-user.js --username juan --role ventas --database-key lang
node dist/cli/create-user.js --username juan --rotate
node dist/cli/create-user.js --username juan --disable
```

La CLI valida que el rol exista en `circuit-access.yaml`, que el `databaseKey`
esté en `DATABASE_KEYS` y que el username sea único. Los cambios se aplican sin reiniciar.

Conectarlo a Claude Code:

```bash
claude mcp add --transport http popey http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <token>"
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
