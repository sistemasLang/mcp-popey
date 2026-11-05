# tenant-isolation Specification

## Purpose
Garantiza que cada usuario consulte solo la base de su tenant: el `databaseKey` sale del `UserContext` y apunta a una configuración de conexión que vive únicamente en variables de entorno.

## Requirements

### Requirement: databaseKey solo server-side
La base de cada consulta SHALL ser siempre `UserContext.databaseKey`. `QueryExecutor` MUST NOT tener otra forma de elegir base, y ningún input de tool puede aportar ni influir en ella.

#### Scenario: Dos tenants
- **WHEN** usuarios de los tenants `lang` y `cliente_b` hacen la misma consulta
- **THEN** cada uno recibe filas solo de su propia base

### Requirement: Registro de bases por entorno
`DATABASE_KEYS` SHALL listar las claves separadas por coma; cada clave MUST cumplir `^[a-z0-9_]{1,32}$` y tener `DB_<KEY>_HOST`, `_NAME`, `_USER` y `_PASSWORD` (más `_PORT`, default 5432, y `_SSL`, default false). Una configuración incompleta MUST impedir el arranque.

#### Scenario: Variable faltante
- **WHEN** `DATABASE_KEYS=lang` pero falta `DB_LANG_PASSWORD`
- **THEN** el arranque falla nombrando la variable faltante sin mostrar valores

#### Scenario: Usuario con clave no configurada
- **WHEN** un usuario tiene un `databaseKey` que ya no está en `DATABASE_KEYS`
- **THEN** sus consultas fallan con un error controlado que no expone datos de conexión

### Requirement: User nunca contiene datos de conexión
El modelo `User` SHALL guardar solo el nombre lógico `databaseKey`. Host, puerto, nombre de base, usuario, contraseña o connection string MUST NOT aparecer en `users.yaml`, en la auditoría ni en errores.

#### Scenario: Inspección de users.yaml
- **WHEN** se lee `users.yaml`
- **THEN** solo contiene `id, username, role, databaseKey, enabled, tokenSha256, createdAt`

### Requirement: Un pool por tenant
`PoolManager` SHALL crear de forma perezosa un `pg.Pool` por `databaseKey` y reutilizarlo (`max = DB_POOL_MAX`, default 5; idle 30 s; timeout de conexión 5 s; `application_name = mcp-popey`). Con `_SSL=true` la conexión se cifra sin verificar identidad (los servidores de tenant usan certificados autofirmados).

#### Scenario: Error en cliente inactivo
- **WHEN** una conexión inactiva del pool falla
- **THEN** el proceso no se cae y el pool descarta ese cliente
