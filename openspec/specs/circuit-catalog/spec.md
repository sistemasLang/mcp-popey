# circuit-catalog Specification

## Purpose
Carga `config/circuits.yaml` (los circuitos de negocio del ERP Popey y sus tablas) y decide, una vez al arranque, qué tablas y columnas son consultables. Es la única fuente de identificadores que pueden llegar a SQL.

## Requirements

### Requirement: Validación estructural al arranque
El servidor SHALL leer `circuits.yaml` una sola vez al iniciar y validarlo con un schema estricto. Cualquier error de lectura, de YAML o de estructura MUST impedir el arranque con `ConfigurationError`. Las tools nunca leen el archivo.

#### Scenario: YAML inválido
- **WHEN** `circuits.yaml` tiene YAML mal formado o una propiedad no declarada
- **THEN** el proceso termina con código 1 y no abre el puerto

#### Scenario: Identificadores
- **WHEN** un circuito no cumple `^[a-z0-9_]{1,64}$` o una tabla no es `schema.tabla` en snake_case minúscula
- **THEN** el arranque falla

### Requirement: Tabla consultable por defecto denegada
Una tabla SHALL ser consultable solo si no tiene ninguna razón de denegación. Las razones son: `needs_review`, `legacy`, `unknown_status` (cualquier otro status), `blocked_schema` y `no_confirmed_columns`.

#### Scenario: Status restringido
- **WHEN** una tabla tiene `status: needs_review` o `legacy`
- **THEN** no es consultable y su razón aparece en `notQueryableReasons`

#### Scenario: Status desconocido
- **WHEN** una tabla tiene un status no reconocido
- **THEN** no es consultable con razón `unknown_status`

### Requirement: Solo columnas confirmadas
Solo las entradas de `key_columns` que cumplan `^[a-z_][a-z0-9_]{0,62}$` SHALL considerarse columnas reales. Las entradas en prosa (por ejemplo `"columnas no confirmadas…"`) MUST descartarse, y una tabla sin columnas confirmadas MUST quedar no consultable.

#### Scenario: key_columns documental
- **WHEN** una tabla solo tiene `key_columns: ["columnas no confirmadas"]`
- **THEN** no es consultable con razón `no_confirmed_columns`

### Requirement: pending_columns solo informativas
Las `pending_columns` de un circuito SHALL mostrarse en `describe_circuit` pero MUST NOT ser seleccionables, filtrables ni ordenables, aunque también figuren en `key_columns`.

#### Scenario: Columna pendiente
- **WHEN** se intenta seleccionar una columna declarada como pending
- **THEN** la consulta falla con `COLUMN_NOT_ALLOWED` indicando que está documentada como pendiente

### Requirement: Tablas repetidas
La misma tabla en distintos circuitos SHALL evaluarse por circuito de forma independiente. Repetida dentro de un mismo circuito, sus entradas MUST fusionarse (columnas sin duplicar, status unidos, descripciones y notas concatenadas con ` | `) y si alguna entrada está restringida gana la restricción.

#### Scenario: Entrada restringida fusionada
- **WHEN** un circuito lista `stock.articulo` dos veces y una entrada tiene `needs_review`
- **THEN** `stock.articulo` no es consultable en ese circuito

### Requirement: Schemas bloqueados en código
El servidor SHALL mantener una lista `BLOCKED_SCHEMAS` (comparación sin distinguir mayúsculas) cuyas tablas MUST quedar no consultables con razón `blocked_schema`, chequeado de nuevo en `AuthorizationService` y `QueryValidator`. Hoy la lista no contiene ningún schema real: el schema `seguridad` está habilitado a propósito para el circuito `usuario`.

#### Scenario: Schema en la lista
- **WHEN** un schema agregado a `BLOCKED_SCHEMAS` aparece en `circuits.yaml`
- **THEN** todas sus tablas son no consultables en cualquier circuito

#### Scenario: seguridad habilitado
- **WHEN** un rol con acceso al circuito `usuario` consulta `seguridad.usuario`
- **THEN** el MCP lo permite, limitado a las `key_columns` declaradas

### Requirement: Credenciales fuera de key_columns
Las columnas de credenciales, 2FA, bloqueo y datos personales sensibles (por ejemplo `vpassword`, `vhashrecupclave`, `vcodigo2fa`, `bbloqueoauto`, `dfechanacimiento`) MUST NOT figurar en `key_columns`, de modo que nunca sean seleccionables ni filtrables.

#### Scenario: Pedido de contraseña
- **WHEN** un cliente pide `select: ["vpassword"]` sobre `seguridad.usuario`
- **THEN** la consulta falla con `COLUMN_NOT_ALLOWED`

### Requirement: Verificación contra la base viva
Cada tabla y columna de `circuits.yaml` SHALL estar verificada contra la base real (pg_catalog) y registrar `source` con la fecha de verificación. Si la base no tiene una tabla o columna documentada, la consulta MUST fallar con un error controlado y no con texto de PostgreSQL.

#### Scenario: Drift entre YAML y base
- **WHEN** se consulta una columna documentada que no existe en la base del tenant
- **THEN** el cliente recibe `DATABASE_QUERY_ERROR` con el mensaje "A table or column documented in circuits.yaml does not exist in this database"
