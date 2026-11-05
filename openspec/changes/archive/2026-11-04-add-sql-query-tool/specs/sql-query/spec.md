# Spec Delta

## Purpose

Permite que el modelo consulte la base de su tenant con SQL de solo lectura escrito por él mismo, sin allowlist en el servidor, delegando la garantía de lectura en PostgreSQL.

## ADDED Requirements

### Requirement: Input de query_sql
La tool `query_sql` SHALL recibir un objeto estricto `{ sql }` con `sql` como string no vacío de hasta 100.000 caracteres. Cualquier otra propiedad (`databaseKey`, `params`, `schema`, `role`) MUST rechazarse por validación.

#### Scenario: SQL válido
- **WHEN** un usuario habilitado envía `{ "sql": "SELECT count(*) FROM stock.factura_venta" }`
- **THEN** la consulta se ejecuta sobre la base de su tenant

#### Scenario: Propiedad extra
- **WHEN** el input incluye `databaseKey`
- **THEN** la llamada se rechaza por validación sin ejecutar SQL

#### Scenario: SQL vacío
- **WHEN** `sql` es un string vacío
- **THEN** la llamada se rechaza por validación

### Requirement: SQL sin restricciones del servidor
El servidor SHALL enviar el SQL a PostgreSQL tal como lo escribió el modelo, sin parsearlo, reescribirlo, filtrar tablas o columnas ni agregar `LIMIT`. Joins, agregaciones, CTEs, funciones de ventana, `EXPLAIN` y consultas a `information_schema` o `pg_catalog` MUST funcionar si el rol de base lo permite.

#### Scenario: Agregación con join
- **WHEN** el modelo envía un `SELECT` con `JOIN`, `GROUP BY` y `SUM`
- **THEN** recibe el resultado agregado calculado por PostgreSQL

#### Scenario: Introspección
- **WHEN** el modelo consulta `information_schema.columns`
- **THEN** recibe las columnas de las tablas a las que el rol tiene acceso

### Requirement: Una sola sentencia por llamada
Cada llamada SHALL ejecutar exactamente una sentencia SQL. Un texto con varias sentencias MUST ser rechazado por PostgreSQL sin ejecutar ninguna.

#### Scenario: Intento de salir de la transacción
- **WHEN** el modelo envía `COMMIT; SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; DELETE FROM venta.cliente`
- **THEN** la llamada falla con un error de SQL y no se ejecuta ninguna de las sentencias

### Requirement: Solo lectura garantizada por la base
Cada sentencia SHALL ejecutarse en una transacción de solo lectura que siempre se revierte, con el rol de base de solo lectura del tenant. Toda escritura, DDL o efecto persistente MUST fallar, aunque venga dentro de una función.

#### Scenario: Escritura directa
- **WHEN** el modelo envía `UPDATE venta.cliente SET vnombre = 'x'`
- **THEN** la llamada falla con un error de SQL de transacción de solo lectura o de permiso denegado

#### Scenario: Escritura dentro de una función
- **WHEN** el modelo invoca con `SELECT` una función que inserta filas
- **THEN** la llamada falla y no persiste ningún cambio

#### Scenario: Cambio de configuración de sesión
- **WHEN** el modelo ejecuta `SELECT set_config('default_transaction_read_only', 'off', false)`
- **THEN** el cambio se revierte al terminar la llamada y la siguiente llamada sigue siendo de solo lectura

### Requirement: Timeout de query_sql
Cada sentencia SHALL cancelarse si supera `QUERY_SQL_TIMEOUT_MS` (default 30000 ms), configurable por entorno e independiente del timeout de `query_circuit`.

#### Scenario: Consulta lenta
- **WHEN** una sentencia tarda más que el timeout configurado
- **THEN** PostgreSQL la cancela y el cliente recibe `QUERY_TIMEOUT`

### Requirement: Resultado con tope de filas
La respuesta SHALL ser `{ columns, rows, rowCount, truncated }`. Se devuelven como máximo `QUERY_SQL_MAX_ROWS` filas (default 1000, configurable por entorno); si la sentencia produce más, MUST devolver solo las primeras, poner `truncated: true` y no leer el resto.

#### Scenario: Resultado chico
- **WHEN** la sentencia devuelve 12 filas
- **THEN** la respuesta trae las 12 filas, `rowCount: 12` y `truncated: false`

#### Scenario: Resultado grande
- **WHEN** la sentencia produciría 50.000 filas
- **THEN** la respuesta trae 1000 filas, `rowCount: 1000` y `truncated: true`

#### Scenario: Sentencia sin filas
- **WHEN** la sentencia es un `EXPLAIN`
- **THEN** la respuesta trae el plan como filas y `truncated: false`

### Requirement: Tipos de resultado de query_sql
Los valores SHALL devolverse con los mismos criterios de tipo que `query_circuit`: las columnas `DATE` como `YYYY-MM-DD`. `columns` MUST listar los nombres de columna en el orden en que los devuelve la sentencia.

#### Scenario: Fecha
- **WHEN** la sentencia devuelve una columna DATE `2026-10-01`
- **THEN** el valor es exactamente `"2026-10-01"`

### Requirement: Tenant del UserContext
`query_sql` SHALL ejecutarse siempre sobre la base de `UserContext.databaseKey`, igual que `query_circuit`. El SQL MUST NOT poder elegir ni conectarse a otra base del servidor.

#### Scenario: Intento de cambiar de base
- **WHEN** el modelo envía `\c otra_base` o intenta usar `dblink` hacia otra base
- **THEN** la llamada falla y no se lee ninguna otra base
