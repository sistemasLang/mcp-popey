# Proposal

## Why

`query_circuit` (DSL: una tabla por llamada, allowlist de columnas, sin joins, sin agregaciones, `limit` ≤ 500) le agrega fricción innecesaria al modelo: encadena muchas llamadas y suma filas a mano para responder lo que `query_sql` resuelve en una sola sentencia. En la práctica ya se usa solo `query_sql`. Por decisión del negocio, por ahora no hay limitación de tablas por rol, así que el DSL (la única vía que aplicaba permisos por circuito y por columna) deja de tener razón de ser.

## What Changes

- **BREAKING** Se elimina la tool `query_circuit` y todo su soporte: `QueryCircuitUseCase`, `QueryValidator`, `QueryCompiler`, los tipos del DSL, `QueryCircuitSchema`, `ReadOnlyDatabasePort.executeSelect` y los errores `TABLE_NOT_ALLOWED` y `COLUMN_NOT_ALLOWED`.
- **BREAKING** Se elimina el flag `roles.<rol>.sql` de `circuit-access.yaml`: todo rol definido en el archivo puede usar `query_sql`. Un archivo que todavía lo declare impide el arranque (no se ignora en silencio).
- **BREAKING** Se eliminan las variables `QUERY_DEFAULT_ROWS`, `QUERY_MAX_ROWS`, `QUERY_MAX_SELECTED_COLUMNS`, `QUERY_MAX_FILTERS`, `QUERY_MAX_ORDER_BY`, `QUERY_MAX_IN_VALUES`, `QUERY_MAX_VALUE_LENGTH` y `QUERY_TIMEOUT_MS`. Si quedan en un `.env` viejo se ignoran. El `statement_timeout` de la sesión pasa a ser `QUERY_SQL_TIMEOUT_MS`.
- `list_circuits` y `describe_circuit` se mantienen como documentación de negocio para escribir SQL. `queryable` sigue marcando tablas confirmadas, pero ya no es un permiso.
- Los mensajes de error por SQLSTATE dejan de mencionar filtros y `circuits.yaml`.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `query-dsl`: se elimina completa.
- `mcp-tools`: tres tools (`list_circuits`, `describe_circuit`, `query_sql`), las tres para todo rol definido.
- `role-authorization`: los circuitos solo acotan el catálogo; sin flag `sql`; sin autorización de tabla.
- `circuit-catalog`: `queryable` y `pending_columns` pasan a ser documentación; la protección de credenciales queda en PostgreSQL.
- `rate-limiting`: solo `query_sql` consume cuota.
- `safe-errors`: sin `TABLE_NOT_ALLOWED` ni `COLUMN_NOT_ALLOWED`; mensajes genéricos por SQLSTATE.
- `audit-logging`: sin `table`, `columns` ni `filterFields`.
- `runtime-configuration`: sin las variables del DSL.
- `read-only-execution`: el timeout de sesión es `QUERY_SQL_TIMEOUT_MS`.
- `tenant-isolation`: solo `QuerySqlUseCase` elige base, siempre desde `UserContext`.
- `sql-query`: deja de referirse a `query_circuit`.

## Impacto en seguridad

| Barrera | Antes | Después |
|---|---|---|
| Permisos por circuito (`circuit-access.yaml`) | Acotaban `query_circuit` | **Se debilita**: solo acotan qué circuitos muestra el catálogo. Todo rol definido lee con `query_sql` todo lo que lee `mcp_popey_ro`. Aceptado explícitamente por el negocio ("por ahora no hay limitación de tablas por roles") |
| Opt-in `sql: true` por rol | Gate de `query_sql` | **Se elimina**: el gate pasa a ser "rol definido en `circuit-access.yaml`" (deny by default para cualquier otro) |
| Allowlist de columnas (`key_columns`) | Barrera en Node para el DSL | Desaparece como barrera. Las credenciales de `seguridad` siguen protegidas por grants por columna de `mcp_popey_ro` (42501), ya cubiertos por tests de integración |
| Solo lectura | Rol SELECT + `BEGIN READ ONLY` + una sentencia | Sin cambios |
| Aislamiento por tenant | `databaseKey` server-side | Sin cambios |
| Carga sobre la base | DSL + `LIMIT` + timeouts | `QUERY_SQL_TIMEOUT_MS` + rate limit por usuario + tope de filas devueltas (sin cambios en `query_sql`) |

Cualquier restricción futura de lectura por rol se hace en PostgreSQL (un rol de base por rol de negocio, o grants), no reintroduciendo filtros en Node.

## Fuera de alcance

- Roles de PostgreSQL por rol de negocio.
- Cambiar `config/circuit-access.yaml` real (no declara `sql`, no requiere cambios).
- Cambiar `circuits.yaml` o el formato de `describe_circuit`.
- Cambios en `query_sql` (input, límites, diagnóstico).

## Impact

- Código: `api/adapters/inbound/mcp/*`, `api/application/{services,use-cases,ports}`, `api/domain/{errors,role-policy,security/query-limits}`, `api/domain/query/` (eliminado), `api/adapters/outbound/{postgres,yaml}`, `api/config/*`, `api/composition/*`.
- Tests: se elimina `test/unit/query.test.ts`; se adaptan e2e, permisos, config, errores e integración.
- Docs: README, `config/circuit-access.example.yaml`, `openspec/config.yaml`.
- Despliegue: quitar `sql:` de cualquier `circuit-access.yaml` desplegado antes de actualizar.
