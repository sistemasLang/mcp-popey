# query-dsl Specification

## Purpose
Define el lenguaje de consulta que acepta `query_circuit` (select, filtros, orden, límite), su validación de autorización y su compilación a SQL parametrizado. Reemplaza cualquier forma de SQL libre.

## Requirements

### Requirement: Validación completa, sin correcciones silenciosas
`QueryValidator` SHALL rechazar la consulta entera ante cualquier problema; nunca MUST descartar, recortar ni corregir partes del request.

#### Scenario: Una columna inválida entre varias
- **WHEN** `select` contiene una columna permitida y otra no permitida
- **THEN** falla toda la consulta con `COLUMN_NOT_ALLOWED`

### Requirement: Select
`select` SHALL contener entre 1 y `QUERY_MAX_SELECTED_COLUMNS` (default 30) columnas, sin duplicados, todas permitidas en la tabla.

#### Scenario: Columnas duplicadas
- **WHEN** `select` repite una columna
- **THEN** falla con `INVALID_QUERY`

#### Scenario: Demasiadas columnas
- **WHEN** `select` supera el máximo configurado
- **THEN** falla con `INVALID_QUERY`

### Requirement: Filtros
Los filtros SHALL combinarse con AND, como máximo `QUERY_MAX_FILTERS` (default 20), y solo sobre columnas permitidas. Los operadores válidos son `eq neq gt gte lt lte in contains startsWith isNull isNotNull`. Los valores escalares MUST ser string (hasta `QUERY_MAX_VALUE_LENGTH`, default 500), number finito o boolean.

#### Scenario: isNull con valor
- **WHEN** un filtro `isNull` trae `value`
- **THEN** falla con `INVALID_QUERY`

#### Scenario: in vacío o excesivo
- **WHEN** `in` recibe un array vacío o con más de `QUERY_MAX_IN_VALUES` (default 100) valores
- **THEN** falla con `INVALID_QUERY`

#### Scenario: contains con no-string
- **WHEN** `contains` o `startsWith` reciben un número o un string vacío
- **THEN** falla con `INVALID_QUERY`

### Requirement: Orden y límite
`orderBy` SHALL aceptar como máximo `QUERY_MAX_ORDER_BY` (default 5) entradas sobre columnas permitidas con dirección `asc` o `desc`. `limit` MUST ser un entero entre 1 y `QUERY_MAX_ROWS` (default 500); si se omite se usa `QUERY_DEFAULT_ROWS` (default 100).

#### Scenario: Límite por defecto
- **WHEN** el request no trae `limit`
- **THEN** se aplica 100 y la respuesta informa `limit: 100`

#### Scenario: Límite excesivo
- **WHEN** `limit` es 1000
- **THEN** falla con `INVALID_QUERY`, sin recortarlo a 500

### Requirement: Compilación a SQL parametrizado
`QueryCompiler` SHALL ser el único componente que escribe texto SQL. Los identificadores MUST provenir del `CircuitRegistry`, revalidarse contra `^[a-z_][a-z0-9_]{0,62}$` y citarse con comillas dobles; todo valor, incluido el `LIMIT`, MUST viajar como parámetro `$n`.

#### Scenario: Inyección en un valor
- **WHEN** un filtro trae `value: "x' UNION SELECT vpassword FROM seguridad.usuario --"`
- **THEN** el texto viaja como parámetro y se compara literalmente, sin alterar el SQL

#### Scenario: Inyección en un identificador
- **WHEN** `field` es `(SELECT vpassword FROM seguridad.usuario)`
- **THEN** falla con `COLUMN_NOT_ALLOWED` antes de compilar

### Requirement: Semántica de operadores
`in` SHALL compilar a `= ANY($n)`. `contains` y `startsWith` SHALL compilar a `columna::text ILIKE $n ESCAPE '\'` (sin distinguir mayúsculas), escapando `%`, `_` y `\` del valor para que sean literales.

#### Scenario: Comodín literal
- **WHEN** `contains` recibe `"50%"`
- **THEN** busca el texto literal `50%` y no lo trata como comodín
