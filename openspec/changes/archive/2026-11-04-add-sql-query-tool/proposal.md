# Proposal

## Why

El DSL de `query_circuit` (allowlist de columnas, sin joins, sin agregaciones, sin `OR`, sin paginación y `limit` ≤ 500) obliga al modelo a encadenar muchas consultas y sumar filas a mano, y hay preguntas de negocio que directamente no puede responder ("¿cuánto se facturó en octubre?" con más de 500 facturas). La decisión es que, mientras la consulta sea de lectura, el modelo pueda escribir el SQL que necesite. Para que eso sea seguro, la protección pasa de Node (allowlist) a PostgreSQL (rol de solo lectura y grants).

## What Changes

- Nueva tool MCP `query_sql` con input `{ sql }`: el modelo escribe cualquier sentencia de lectura (SELECT, WITH, joins, agregaciones, ventanas, `EXPLAIN`, `information_schema`, `pg_catalog`). Node no parsea ni reescribe el SQL.
- La lectura se garantiza en PostgreSQL: una sola sentencia por llamada (protocolo extendido), transacción `READ ONLY` siempre revertida, rol `mcp_popey_ro` solo con `SELECT` y `statement_timeout` propio (default 30 s).
- El SQL no lleva `LIMIT` impuesto. Para no saturar el contexto del modelo ni la memoria del proceso, la respuesta trae como máximo `QUERY_SQL_MAX_ROWS` filas (default 1000) y avisa con `truncated: true` cuando hay más, sugiriendo agregar o paginar.
- Los errores de SQL devuelven el diagnóstico real de PostgreSQL (SQLSTATE, mensaje, hint, posición) para que el modelo corrija su consulta sin adivinar. Los errores de conexión siguen siendo genéricos.
- Acceso por rol con opt-in: solo los roles con `sql: true` en `circuit-access.yaml` ven y usan `query_sql`. Se propone habilitarlo para `administrador` (requiere aprobación del negocio).
- Columnas sensibles de `seguridad` protegidas por **grants por columna** en `scripts/create_readonly_role.sql`: el rol puede leer `nusuario`, nombre, roles, etc., pero nunca `vpassword`, hashes, 2FA ni `dfechanacimiento`. Esto reemplaza el `REVOKE ALL` sobre `seguridad` y alinea el script con el desbloqueo intencional del schema.
- Se alinea el resto del drift de `seguridad`: los tests que esperan el schema bloqueado, el README, el comentario de `blocked-schemas.ts` y el `naming_note` del circuito `usuario`.
- `list_circuits`, `describe_circuit` y `query_circuit` se mantienen sin cambios. Los circuitos pasan a ser también la documentación de negocio que el modelo usa para escribir SQL.

## Capabilities

### New Capabilities
- `sql-query`: ejecución de SQL de solo lectura escrito por el modelo, con sus garantías (una sentencia, transacción READ ONLY, timeout, tope de filas en la respuesta) y su contrato de entrada y salida.

### Modified Capabilities
- `mcp-tools`: la superficie pasa de tres a cuatro tools; `query_sql` solo se registra para roles habilitados.
- `role-authorization`: nuevo flag `sql` por rol (deny by default) y aclaración de que los permisos por circuito no acotan a `query_sql`.
- `read-only-execution`: el rol `mcp_popey_ro` recibe `USAGE` sobre `seguridad` y `SELECT` solo sobre columnas no sensibles; se suma el requisito de una sola sentencia por ejecución.
- `safe-errors`: los errores de SQL de `query_sql` exponen el diagnóstico de PostgreSQL.
- `audit-logging`: los eventos de `query_sql` registran hash y largo del SQL, filas devueltas y truncamiento.
- `rate-limiting`: `query_sql` consume la misma cuota que `query_circuit`.

## Impacto en seguridad

Barreras que toca este cambio:

| Barrera | Antes | Con `query_sql` |
|---|---|---|
| Allowlist de tablas y columnas (`circuits.yaml`) | Única vía de consulta | **No aplica** a `query_sql`. La reemplazan los grants de PostgreSQL |
| Permisos por circuito (`circuit-access.yaml`) | Acotan qué ve cada rol | **No acotan** a `query_sql`: un rol habilitado lee todo lo que `mcp_popey_ro` puede leer. Aceptado explícitamente; se mitiga con el opt-in `sql: true` por rol |
| Exclusión de credenciales | `key_columns` sin `vpassword` | Grants por columna en `seguridad` (PostgreSQL lo rechaza con 42501) |
| Solo lectura | Rol SELECT + `BEGIN READ ONLY` | Igual, más una sola sentencia por llamada para que no se pueda salir de la transacción con `COMMIT; ...` |
| Aislamiento por tenant | Base por tenant + `databaseKey` server-side | Sin cambios |
| Carga sobre la base | DSL + `LIMIT` ≤ 500 + 10 s | `statement_timeout` de 30 s + rate limit por usuario + tope de filas devueltas |

Riesgos que quedan cubiertos por PostgreSQL:
- Funciones con efectos (incluidas `SECURITY DEFINER`) fallan dentro de una transacción READ ONLY.
- `nextval`, `lo_import` y `pg_read_file` requieren privilegios que el rol no tiene.

Supuesto: las bases de Popey no tienen `dblink` ni `postgres_fdw` instaladas (confirmado por el usuario; ver design.md).

## Fuera de alcance

- Roles de PostgreSQL por rol de negocio (permisos por circuito aplicados en la base).
- Parseo, allowlist o reescritura de SQL en Node.
- Cualquier operación de escritura o DDL.
- Registrar el texto completo del SQL en auditoría (puede contener datos personales en los literales).
- Quitar `query_circuit` o cambiar el DSL.
- Defensas contra prompt injection contenida en los datos leídos.

## Impact

- Código nuevo: `src/mcp/tools/query-sql.tool.ts` y `src/sql/` (schema de input, executor y mapeo de errores).
- Código modificado: `src/database/database.adapter.ts` (ejecución con cursor y protocolo extendido), `src/permissions/role-policy.*` (flag `sql`), `src/mcp/server.ts`, `src/audit/audit.logger.ts`, `src/config/env.ts` y `config.ts` (`QUERY_SQL_MAX_ROWS`, `QUERY_SQL_TIMEOUT_MS`), `src/security/blocked-schemas.ts` (comentario).
- Dependencia nueva: `pg-cursor`, del mismo proyecto que `pg`.
- Configuración: `config/circuit-access.yaml` (`sql: true` en `administrador`, con aprobación), `config/circuit-access.example.yaml` y `config/circuits.yaml` (`naming_note` del circuito `usuario`).
- Base de datos: re-ejecutar `scripts/create_readonly_role.sql` en cada tenant.
- Tests: unitarios y e2e de `query_sql`, integración con testcontainers (multi-sentencia, escritura, columnas sensibles, timeout, truncamiento) y alineación de los 10 tests de `seguridad`.
- Documentación: `README.md` y `openspec/config.yaml` (la regla "nunca SQL libre" pasa a "nunca escritura").
