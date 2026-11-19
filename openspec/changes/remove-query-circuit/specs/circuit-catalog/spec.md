# Spec Delta

## MODIFIED Requirements

### Requirement: Tabla consultable por defecto denegada
Una tabla SHALL marcarse `queryable` solo si no tiene ninguna razón de denegación. Las razones son: `needs_review`, `legacy`, `unknown_status` (cualquier otro status), `blocked_schema` y `no_confirmed_columns`. `queryable` es documentación para el modelo, no un permiso: `query_sql` no lo consulta.

#### Scenario: Status restringido
- **WHEN** una tabla tiene `status: needs_review` o `legacy`
- **THEN** se describe con `queryable: false` y su razón aparece en `notQueryableReasons`

#### Scenario: Status desconocido
- **WHEN** una tabla tiene un status no reconocido
- **THEN** se describe con `queryable: false` y razón `unknown_status`

### Requirement: Solo columnas confirmadas
Solo las entradas de `key_columns` que cumplan `^[a-z_][a-z0-9_]{0,62}$` SHALL considerarse columnas reales. Las entradas en prosa (por ejemplo `"columnas no confirmadas…"`) MUST descartarse, y una tabla sin columnas confirmadas MUST describirse como no consultable.

#### Scenario: key_columns documental
- **WHEN** una tabla solo tiene `key_columns: ["columnas no confirmadas"]`
- **THEN** se describe con `queryable: false` y razón `no_confirmed_columns`

### Requirement: pending_columns solo informativas
Las `pending_columns` de un circuito SHALL mostrarse en `describe_circuit` solo como documentación y MUST NOT listarse entre las `columns` confirmadas de la tabla.

#### Scenario: Columna pendiente
- **WHEN** una columna está declarada como pending
- **THEN** `describe_circuit` la muestra en `pendingColumns` y no en `columns`

### Requirement: Schemas bloqueados en código
El servidor SHALL mantener una lista `BLOCKED_SCHEMAS` (comparación sin distinguir mayúsculas) cuyas tablas MUST describirse como no consultables con razón `blocked_schema`. Hoy la lista no contiene ningún schema real: el schema `seguridad` está documentado a propósito en el circuito `usuario`.

#### Scenario: Schema en la lista
- **WHEN** un schema agregado a `BLOCKED_SCHEMAS` aparece en `circuits.yaml`
- **THEN** todas sus tablas se describen con `queryable: false` en cualquier circuito

#### Scenario: seguridad habilitado
- **WHEN** un rol con acceso al circuito `usuario` lo describe
- **THEN** ve `seguridad.usuario` con sus `key_columns` seguras

### Requirement: Credenciales fuera de key_columns
Las columnas de credenciales, 2FA, bloqueo y datos personales sensibles (por ejemplo `vpassword`, `vhashrecupclave`, `vcodigo2fa`, `bbloqueoauto`, `dfechanacimiento`) MUST NOT figurar en `key_columns`, y el rol `mcp_popey_ro` MUST NOT tener grant sobre ellas: la base es la barrera que impide leerlas.

#### Scenario: Descripción sin credenciales
- **WHEN** se describe el circuito `usuario`
- **THEN** ninguna tabla lista `vpassword` ni `vcodigo2fa` en `columns`

#### Scenario: Pedido de contraseña
- **WHEN** el modelo envía `SELECT vpassword FROM seguridad.usuario` por `query_sql`
- **THEN** recibe `AUTHORIZATION_ERROR` con `sqlState: "42501"`

### Requirement: Verificación contra la base viva
Cada tabla y columna de `circuits.yaml` SHALL estar verificada contra la base real (pg_catalog) y registrar `source` con la fecha de verificación.

#### Scenario: Drift entre YAML y base
- **WHEN** el modelo consulta por `query_sql` una columna documentada que no existe en la base del tenant
- **THEN** recibe `DATABASE_QUERY_ERROR` con el diagnóstico de PostgreSQL para corregir su SQL
