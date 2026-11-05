# mcp-tools Specification

## Purpose
Define la superficie pública del servidor MCP: el endpoint HTTP, las únicas tres tools expuestas, la forma estricta de sus inputs y el formato de sus respuestas exitosas y de error.

## Requirements

### Requirement: Endpoint Streamable HTTP stateless
El servidor SHALL atender MCP solo en la ruta `/mcp` mediante Streamable HTTP sin sesión, creando un `McpServer` y un transporte nuevos por cada request autenticado y cerrándolos cuando la respuesta termina.

#### Scenario: Ruta distinta de /mcp
- **WHEN** llega un request HTTP a cualquier ruta distinta de `/mcp`
- **THEN** el servidor responde 404 sin cuerpo y sin intentar autenticar

#### Scenario: Request sin autenticación válida
- **WHEN** llega un request a `/mcp` sin token Bearer válido
- **THEN** el servidor responde 401 con header `WWW-Authenticate: Bearer realm="mcp-popey"` y un cuerpo JSON-RPC con `error.code = -32001` y `message = "Unauthorized"`, sin crear un `McpServer`

#### Scenario: Error inesperado del handler HTTP
- **WHEN** ocurre un error no controlado antes de enviar headers
- **THEN** el servidor responde 500 con un error JSON-RPC `-32603 "Internal error"` y registra el detalle solo en stderr

### Requirement: Tools de lectura
El servidor SHALL registrar las tools `list_circuits`, `describe_circuit` y `query_circuit` para todo usuario autenticado, y `query_sql` solo para usuarios cuyo rol tenga `sql: true`. Todas MUST declarar `readOnlyHint: true` y `openWorldHint: false`. El servidor MUST NOT exponer ninguna tool que escriba datos.

#### Scenario: Listado de tools
- **WHEN** un usuario cuyo rol no tiene `sql: true` pide `tools/list`
- **THEN** recibe únicamente `list_circuits`, `describe_circuit` y `query_circuit`

#### Scenario: Listado de tools para un rol con SQL
- **WHEN** un usuario cuyo rol tiene `sql: true` pide `tools/list`
- **THEN** recibe además `query_sql`

#### Scenario: Intento de usar query_sql sin habilitación
- **WHEN** un usuario cuyo rol no tiene `sql: true` invoca `query_sql`
- **THEN** la llamada falla porque la tool no existe para ese usuario

#### Scenario: Intento de tool inexistente
- **WHEN** un cliente invoca una tool como `execute_write`
- **THEN** la llamada falla porque la tool no existe

### Requirement: Inputs estrictos
Los inputs de las tools SHALL validarse con schemas Zod `strict`: cualquier propiedad no declarada (por ejemplo `databaseKey`, `sql`, `schema`, `host`) MUST rechazarse como error de validación, nunca ignorarse en silencio.

#### Scenario: Propiedad extra en query_circuit
- **WHEN** un cliente envía `query_circuit` con una propiedad `databaseKey` o `schema`
- **THEN** la llamada se rechaza por validación y no se ejecuta ninguna consulta

#### Scenario: list_circuits con argumentos
- **WHEN** un cliente envía `list_circuits` con cualquier propiedad
- **THEN** la llamada se rechaza por validación

### Requirement: list_circuits
`list_circuits` SHALL devolver `{ circuits: [{ id, description }] }` con solo los circuitos a los que el rol del usuario tiene acceso.

#### Scenario: Rol con acceso parcial
- **WHEN** un usuario con rol `ventas` (acceso solo a `venta`) invoca `list_circuits`
- **THEN** recibe únicamente el circuito `venta`

#### Scenario: Rol sin permisos
- **WHEN** un usuario cuyo rol no figura en `circuit-access.yaml` invoca `list_circuits`
- **THEN** recibe una lista vacía

### Requirement: describe_circuit
`describe_circuit` SHALL recibir `{ circuit }` y devolver `id`, `description`, `namingNote` y la lista de tablas. Cada tabla consultable MUST incluir `queryable: true`, `columns` y `notes`; cada tabla no consultable MUST incluir `queryable: false`, `status` y `notQueryableReasons`, y nunca `columns`. Las `pendingColumns` se informan en ambos casos solo como documentación.

#### Scenario: Tabla consultable
- **WHEN** se describe un circuito con una tabla sin status restringido y con columnas confirmadas
- **THEN** esa tabla aparece con `queryable: true` y sus columnas permitidas

#### Scenario: Tabla no consultable
- **WHEN** se describe un circuito con una tabla `needs_review`
- **THEN** esa tabla aparece con `queryable: false`, `notQueryableReasons` que incluye `needs_review` y sin `columns`

#### Scenario: Circuito no permitido
- **WHEN** un usuario describe un circuito existente que su rol no tiene
- **THEN** recibe un error `AUTHORIZATION_ERROR`

### Requirement: query_circuit
`query_circuit` SHALL recibir `{ circuit, table, select, filters?, orderBy?, limit? }` y devolver `{ circuit, table, columns, rows, rowCount, limit }`. El orden de procesamiento MUST ser: validación Zod, rate limit, `QueryValidator`, `QueryCompiler`, ejecución sobre la base del `UserContext`.

#### Scenario: Consulta válida
- **WHEN** un usuario autorizado consulta columnas permitidas de una tabla consultable
- **THEN** recibe las filas, el `rowCount` y el `limit` efectivamente aplicado

### Requirement: Formato de resultados y errores de tools
Toda tool SHALL devolver su resultado como un único contenido `text` con JSON. Ante cualquier error, la tool MUST devolver `isError: true` con contenido `{ "error": { "code", "message" } }`, donde `code` es uno de los códigos públicos definidos en `safe-errors`.

#### Scenario: Error de dominio
- **WHEN** `query_circuit` pide una columna no permitida
- **THEN** la respuesta tiene `isError: true` y `error.code = "COLUMN_NOT_ALLOWED"`
