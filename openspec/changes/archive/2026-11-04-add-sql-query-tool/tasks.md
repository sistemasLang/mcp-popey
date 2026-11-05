# Tasks

## 1. Alinear el desbloqueo intencional de `seguridad`

- [x] 1.1 Actualizar el comentario de `src/security/blocked-schemas.ts` para decir que la lista está vacía a propósito y que `seguridad` se protege con `key_columns` y grants por columna; verificar leyendo el archivo
- [x] 1.2 Ajustar los tests que esperan `seguridad` bloqueado (`test/unit/security.test.ts`, `permissions.test.ts`, `circuit.loader.test.ts`, `query.test.ts`, `mcp.e2e.test.ts`) para que verifiquen: tablas de `seguridad` consultables solo por el circuito `usuario`, `vpassword` y demás columnas sensibles rechazadas con `COLUMN_NOT_ALLOWED`, y `isBlockedSchema` aplicado a un schema de prueba; verificar con `npm test` en verde (0 fallos)
- [x] 1.3 Actualizar el `naming_note` y los `role` del circuito `usuario` en `config/circuits.yaml` (ya no "NO consultable") y la sección de `seguridad` del README; verificar que el servidor arranca con `npm run build && npm start` sin errores de configuración

## 2. Grants por columna en `seguridad`

- [x] 2.1 Modificar `scripts/create_readonly_role.sql`: `GRANT USAGE ON SCHEMA seguridad`, `REVOKE ALL ON ALL TABLES IN SCHEMA seguridad` seguido de `GRANT SELECT (cols)` con las `key_columns` actuales de `seguridad.usuario`, `usuarioxrol`, `rol` y `view_usuario` y sin `ALTER DEFAULT PRIVILEGES` para `seguridad`; verificar que el script corre dos veces seguidas sin error en el PostgreSQL de testcontainers
- [x] 2.2 Extender `test/integration/postgres.test.ts`: `SELECT nusuario` OK, `SELECT vpassword` y `SELECT *` sobre `seguridad.usuario` → 42501, INSERT → rechazado; verificar con `npm run test:integration`
- [x] 2.3 Documentar en el README los grants por columna y el paso de re-ejecutar el script por tenant; verificar que el comando documentado coincide con el encabezado del script

## 3. Dependencia y configuración

- [x] 3.1 Agregar `pg-cursor@^2.22.1` (y sus tipos, si no los trae) a `package.json`; verificar con `npm install` y `npm run typecheck`
- [x] 3.2 Agregar `QUERY_SQL_MAX_ROWS` (default 1000) y `QUERY_SQL_TIMEOUT_MS` (default 30000) a `src/config/env.ts` y `AppConfig`, con test unitario de defaults y de valor inválido; verificar con `npm test`

## 4. Habilitación de SQL por rol

- [x] 4.1 Extender el schema de `circuit-access.yaml` en `RolePolicyLoader` con `sql: boolean` (default `false`) y `RolePolicy` con `canUseSql(role)`; tests unitarios para sin flag, `true` y valor no booleano (falla el arranque); verificar con `npm test`
- [x] 4.2 Documentar `sql: true` en `config/circuit-access.example.yaml`; verificar que el ejemplo carga con `RolePolicyLoader` en un test

## 5. Ejecución de SQL en el adapter

- [x] 5.1 Agregar `executeSql(databaseKey, sql, { timeoutMs, maxRows })` a `DatabaseAdapter` y a `PostgresDatabaseAdapter` usando `pg-cursor` dentro de `BEGIN READ ONLY` / `SET LOCAL statement_timeout` / `ROLLBACK`, leyendo `maxRows + 1` filas para calcular `truncated` y devolviendo `columns` desde `fields`; verificar con tests de integración: SELECT simple, `truncated` con 1001 filas generadas por `generate_series`, `EXPLAIN`, columnas DATE como `YYYY-MM-DD`
- [x] 5.2 Mapear errores de `executeSql` conservando el código público por SQLSTATE y adjuntando `diagnostics { sqlState, message, hint, position }` solo para `pg.DatabaseError`, con `redactCredentials`; extender `toPublicError` para serializar `diagnostics`; tests unitarios del mapper (sintaxis 42601, 42501, 57014, error de conexión sin diagnostics)
- [x] 5.3 Tests de integración de solo lectura: varias sentencias (`COMMIT; ...`), `UPDATE`, función que inserta llamada con `SELECT`, `set_config('default_transaction_read_only','off',false)` seguido de otra llamada que intenta escribir, y timeout con `pg_sleep`; verificar con `npm run test:integration`

## 6. Tool `query_sql`

- [x] 6.1 Crear `src/sql/sql.schema.ts` (input strict `{ sql }`, 1–100.000 caracteres) y `src/mcp/tools/query-sql.tool.ts` con rate limit primero, `runTool` con auditoría (`sqlSha256`, `sqlLength`, `rowCount`, `truncated`) y la descripción definida en design.md (decisión 8); extender `AuditEvent` con esos campos; tests unitarios de auditoría que comprueben que el texto SQL no aparece en el evento
- [x] 6.2 Registrar `query_sql` en `createMcpServer` solo cuando `canUseSql(user.role)`, pasando `rolePolicy` en `ToolDependencies` desde `src/app.ts`; verificar con `npm run typecheck`
- [x] 6.3 Extender el adapter falso de `test/e2e-harness.ts` con `executeSql` y agregar tests e2e en `test/unit/mcp.e2e.test.ts`: `tools/list` con y sin `sql: true`, llamada sin habilitación falla, propiedad extra `databaseKey` rechazada, cuota compartida con `query_circuit`, error con `diagnostics`; verificar con `npm test`
- [x] 6.4 Documentar `query_sql` en el README (tabla de tools, flujo, habilitación por rol, tope de filas y variables nuevas); verificar que la tabla de tools lista cuatro tools

## 7. Contexto de OpenSpec y cierre

- [x] 7.1 Actualizar `openspec/config.yaml`: la regla "Nunca existirá una tool de SQL libre" pasa a "nunca escritura; el SQL libre de lectura solo vía `query_sql`, protegido por PostgreSQL", y la restricción de `seguridad` menciona los grants por columna; verificar con `openspec validate --all --strict`
- [x] 7.2 Verificación integral: `npm run typecheck`, `npm test` y `npm run test:integration` en verde

## Workflow follow-up

- Re-ejecutar `scripts/create_readonly_role.sql` en cada tenant y verificar `SELECT vpassword FROM seguridad.usuario` → 42501.
- Con aprobación del negocio, poner `sql: true` en `administrador` en `config/circuit-access.yaml` y reiniciar el contenedor.
- Archivar el change con `/opsx:archive` cuando esté implementado y verificado.
