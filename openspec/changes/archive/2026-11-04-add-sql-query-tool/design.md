# Design

## Context

Hoy toda lectura pasa por `QueryValidator` → `QueryCompiler` → `PostgresDatabaseAdapter.executeSelect`. El adapter ya abre `BEGIN READ ONLY`, aplica `SET LOCAL statement_timeout` y hace `ROLLBACK` siempre. Además el pool abre sesiones con `default_transaction_read_only=on`.

Dos hechos verificados condicionan el diseño:

- `pg@8.23.1` solo usa el protocolo extendido si `values.length > 0` o `queryMode: 'extended'` (`node_modules/pg/lib/query.js`, `requiresPreparation`). Si se pasa un SQL sin parámetros, va por protocolo simple y **acepta varias sentencias**. Con eso, `COMMIT; SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; ...` saldría de la transacción READ ONLY.
- `scripts/create_readonly_role.sql` hoy hace `REVOKE ALL` sobre `seguridad`, en contra del desbloqueo intencional del schema.

Motivación y alcance en proposal.md; comportamiento en `specs/`.

## Goals / Non-Goals

**Goals:**
- Cero fricción en el lenguaje: cualquier SQL de lectura que acepte PostgreSQL.
- Toda garantía de seguridad nueva aplicada por PostgreSQL o por el adapter, nunca por análisis del texto SQL.
- Reutilizar autenticación, `UserContext`, rate limiter, auditoría y mapeo de errores existentes.

**Non-Goals:**
- Detectar en Node si el SQL "es un SELECT".
- Cambiar el camino de `query_circuit`.

## Decisions

### 1. Una sola sentencia mediante cursor del protocolo extendido
**Capa: DatabaseAdapter.**

Se agrega `executeSql(databaseKey, sql, { timeoutMs, maxRows })` al `DatabaseAdapter`. Corre la sentencia con `pg-cursor`:

1. `BEGIN READ ONLY` y `SET LOCAL statement_timeout`.
2. `cursor.read(maxRows + 1)`, cerrar el cursor y `ROLLBACK`.
3. Si llegaron `maxRows + 1` filas, se descarta la última y se marca `truncated: true`.

El cursor usa Parse/Bind/Execute, así que PostgreSQL rechaza varias sentencias ("cannot insert multiple commands into a prepared statement"). Además lee solo las filas necesarias, sin traer 50.000 a memoria.

Alternativas descartadas:
- `client.query({ text, queryMode: 'extended' })`: garantiza una sola sentencia, pero trae todas las filas a memoria antes de poder truncar.
- Envolver en `SELECT * FROM (<sql>) q LIMIT n`: rompe `EXPLAIN` y `SHOW`, falla con un `;` final y es reescribir el SQL del modelo.
- Separar sentencias en Node con un parser: frágil (strings, comentarios, `$$`) y es justo la fricción que se quiere sacar.

`pg-cursor@2.22.1` es del mismo repo que `pg` (peer `pg ^8`), sin dependencias propias relevantes. Es la justificación para la dependencia nueva.

### 2. Solo lectura: tres barreras en PostgreSQL
**Capa: PostgreSQL.** No se agrega ninguna en Node.

1. Grants: `mcp_popey_ro` solo tiene `SELECT`. Es la barrera final.
2. Transacción `READ ONLY` siempre revertida. Bloquea escrituras dentro de funciones (incluidas `SECURITY DEFINER`) y `nextval`. El `ROLLBACK` revierte cualquier `set_config`/`SET` hecho en la sentencia, porque los cambios de GUC son transaccionales al abortar.
3. Una sola sentencia (decisión 1). Impide `COMMIT; ...`. Y `SET TRANSACTION READ WRITE` falla porque ya corrió `SET LOCAL statement_timeout` en la transacción.

### 3. `seguridad` con grants por columna
**Capa: PostgreSQL (`scripts/create_readonly_role.sql`).**

- Se reemplaza el `REVOKE ALL` por `GRANT USAGE ON SCHEMA seguridad`.
- Se otorga `GRANT SELECT (col, ...)` solo con las columnas que hoy están en `key_columns` de `circuits.yaml` para las cuatro tablas. Así hay una sola lista de verdad, ya auditada (excluye `vpassword`, hashes, 2FA, bloqueo y `dfechanacimiento`).
- Antes de los grants se ejecuta `REVOKE ALL ON ALL TABLES IN SCHEMA seguridad`, para que re-correr el script elimine grants de columnas viejas.
- `seguridad` **no** entra en `ALTER DEFAULT PRIVILEGES`: las tablas nuevas de ese schema quedan sin grant hasta revisarlas.

Consecuencia: `SELECT *` sobre esas tablas da 42501. La descripción de la tool lo avisa y el error expone el mensaje (decisión 5), así que el modelo se corrige en un intento.

### 4. Habilitación por rol y registro condicional de la tool
**Capas: Zod de `circuit-access.yaml` (`RolePolicyLoader`) y `createMcpServer`.**

- `RolePolicy` pasa a ser `role → { circuits, sql }`.
- `createMcpServer(user, deps)` registra `query_sql` solo si `rolePolicy.canUseSql(user.role)`. Un usuario sin flag ni la ve en `tools/list`, así no hay que defender en runtime una tool que no existe.
- Se descarta registrarla para todos y rechazar dentro: expone la tool y le hace perder intentos al modelo.

### 5. Errores con diagnóstico
**Capa: mapeo de errores del adapter.**

`toSafeError` conserva el código público por SQLSTATE. Para `executeSql`, si el error es `pg.DatabaseError`, se adjunta `{ sqlState, detail: message, hint, position }` en un campo `diagnostics` del `AppError`, y `toPublicError` lo serializa. `detail` se omite: puede volcar valores de filas en violaciones de constraints, que en solo lectura no aplican, pero no suma.

Los errores de conexión y socket (no `DatabaseError`) quedan genéricos. Todo texto pasa por `redactCredentials`.

### 6. Input, salida y configuración
**Capa: Zod (`src/sql/sql.schema.ts`) y `env.ts`.**

- Input `z.object({ sql: z.string().min(1).max(100_000) }).strict()`.
- Variables nuevas: `QUERY_SQL_MAX_ROWS` (default 1000) y `QUERY_SQL_TIMEOUT_MS` (default 30000).
- Salida `{ columns, rows, rowCount, truncated }`. `columns` sale de `result.fields` del cursor.
- `DATE` como string, por los mismos `typeParsers` del pool.

¿Por qué 1000 filas y no "sin tope"? Una respuesta más grande no entra útil en el contexto del modelo; Claude Code, por ejemplo, avisa o corta las salidas de MCP grandes (`MAX_MCP_OUTPUT_TOKENS`). `truncated: true` le dice al modelo que agregue o pagine con `LIMIT/OFFSET` en su propio SQL.

### 7. Auditoría y rate limit
**Capas: `runTool` y `RateLimiter`.**

- `query_sql` usa `runTool`, con `sqlSha256` y `sqlLength` como detalle previo y `rowCount` y `truncated` del resultado. Se extiende `AuditEvent` con esos campos opcionales.
- `deps.rateLimiter.consume(user.userId)` es la primera instrucción, igual que en `query_circuit`.

### 8. Descripción de la tool
**Capa: registro MCP.**

La descripción es la guía del modelo:
- Solo lectura.
- Una sentencia.
- Usar `describe_circuit` para el significado de negocio e `information_schema.columns` para las columnas.
- En `seguridad`, listar columnas en vez de `SELECT *`.
- Fechas `YYYY-MM-DD`.
- Si `truncated`, agregar o paginar.

## Risks / Trade-offs

- **[Un rol con `sql: true` lee fuera de sus circuitos]** → Aceptado. Se mitiga con el opt-in por rol y la auditoría con `sqlSha256`. La solución completa (un rol PG por rol de negocio) queda fuera de alcance.
- **[Tablas sensibles fuera de `seguridad`]** Por ejemplo, datos personales de clientes en `public.persona`. Hoy `circuits.yaml` los excluye de `key_columns`, pero con SQL libre son legibles. → Lo hace visible esta propuesta. Si hace falta, se agregan grants por columna en un change posterior.
- **[Consultas costosas sobre producción]** → 30 s de timeout, 30 llamadas/min por usuario y pool de 5 conexiones por tenant. El peor caso es 5 consultas pesadas concurrentes por tenant.
- **[Extensiones que abren conexiones nuevas (`dblink`, `postgres_fdw`)]** Una conexión abierta por ellas no hereda la transacción READ ONLY. → **Supuesto confirmado por el usuario (2026-11-04): las bases de Popey nunca las tienen instaladas.** Verificado que no vienen por defecto en PostgreSQL 17 y que solo un superusuario puede instalarlas (`trusted=false`). No se agrega control. Un `REVOKE` solo a `mcp_popey_ro` tampoco serviría, porque las funciones se otorgan a `PUBLIC`. Si algún día se instalan, este supuesto se cae y hay que abrir un change.
- **[Script no re-ejecutado en un tenant]** → El circuito `usuario` y `query_sql` sobre `seguridad` fallan con 42501, sin fuga. Falla en modo seguro.
- **[El modelo ve mensajes de PostgreSQL]** → Exponen nombres de tablas y columnas a los que el rol ya tiene acceso o que el modelo escribió. Nunca exponen credenciales de conexión.

## Migration Plan

1. Merge del código con `sql` en `false` para todos los roles: comportamiento idéntico al actual.
2. Por cada tenant, re-ejecutar `scripts/create_readonly_role.sql` y verificar:
   - `SELECT vpassword FROM seguridad.usuario` → 42501
   - `SELECT nusuario FROM seguridad.usuario` → OK
3. Con aprobación del negocio, poner `sql: true` en `administrador` y reiniciar el contenedor (`circuit-access.yaml` se lee al arrancar).

Rollback: quitar `sql: true` y reiniciar. Los grants por columna en `seguridad` pueden quedar, porque solo habilitan lo que el circuito `usuario` ya documenta.
