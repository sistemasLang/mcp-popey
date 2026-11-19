# Tasks

## 1. Eliminar el DSL

- [x] 1.1 Borrar `query-circuit.tool.ts`, `QueryCircuitUseCase`, `QueryValidator`, `api/domain/query/` (compilador y tipos)
- [x] 1.2 Renombrar `query-circuit.schema.ts` a `circuit-catalog.schema.ts` dejando solo `DescribeCircuitSchema` y `ListCircuitsSchema`
- [x] 1.3 Quitar `executeSelect`, `SelectResult` y `SelectOptions` del puerto y del adapter PostgreSQL; un solo mapeo de errores por SQLSTATE con mensajes genéricos
- [x] 1.4 Quitar `TableNotAllowedError`, `ColumnNotAllowedError`, `canQueryTable`, `getQueryableTable` e `isColumn*`
- [x] 1.5 Quitar `QueryLimits`/`QUERY_LIMITS`, las variables `QUERY_*` del DSL y el chequeo `QUERY_DEFAULT_ROWS > QUERY_MAX_ROWS`; el pool usa `QUERY_SQL_TIMEOUT_MS`
- [x] 1.6 Quitar `table`, `columns` y `filterFields` de `AuditEvent`

## 2. query_sql para todo rol definido

- [x] 2.1 Quitar `sql` de `RolePolicy` y del loader (strict: un `sql:` remanente impide arrancar)
- [x] 2.2 `AuthorizationService.canUseSql` = rol presente en `circuit-access.yaml`
- [x] 2.3 Actualizar descripciones de `list_circuits` y `describe_circuit` para orientar a `query_sql`

## 3. Tests

- [x] 3.1 Borrar `test/unit/query.test.ts`
- [x] 3.2 Unitarios: permisos (rol definido usa `query_sql`, rol ausente no, `sql:` rechazado), use case, config, errores
- [x] 3.3 E2E: tres tools, aislamiento por tenant e inputs estrictos sobre `query_sql`, auditoría, rate limit (catálogo sin cuota)
- [x] 3.4 Integración: multi-tenant por `query_sql` y barreras del adapter con `executeSql`

## 4. Docs

- [x] 4.1 README, `config/circuit-access.example.yaml` y `openspec/config.yaml`
- [ ] 4.2 Quitar las variables `QUERY_*` del DSL de `.env.example`

## 5. Verificación

- [x] 5.1 `npm run typecheck` y `npm test` en verde
- [x] 5.2 `npm run test:integration` en verde
