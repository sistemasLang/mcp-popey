# Spec Delta

## ADDED Requirements

### Requirement: Tools expuestas
El servidor SHALL registrar las tools `list_circuits`, `describe_circuit` y `query_sql` para todo usuario autenticado cuyo rol figure en `circuit-access.yaml`. Un usuario cuyo rol no figure MUST NOT ver `query_sql`. Todas MUST declarar `readOnlyHint: true` y `openWorldHint: false`. El servidor MUST NOT exponer ninguna tool que escriba datos.

#### Scenario: Listado de tools
- **WHEN** un usuario con un rol definido pide `tools/list`
- **THEN** recibe exactamente `list_circuits`, `describe_circuit` y `query_sql`

#### Scenario: Rol no definido
- **WHEN** un usuario cuyo rol no figura en `circuit-access.yaml` pide `tools/list`
- **THEN** no recibe `query_sql`

#### Scenario: Intento de tool inexistente
- **WHEN** un cliente invoca `query_circuit` o `execute_write`
- **THEN** la llamada falla porque la tool no existe

### Requirement: Inputs estrictos sin base ni identidad
Los inputs de las tools SHALL validarse con schemas Zod `strict`: cualquier propiedad no declarada (por ejemplo `databaseKey`, `schema`, `host`, `params`) MUST rechazarse como error de validación, nunca ignorarse en silencio.

#### Scenario: Propiedad extra en query_sql
- **WHEN** un cliente envía `query_sql` con una propiedad `databaseKey` o `schema`
- **THEN** la llamada se rechaza por validación y no se ejecuta ninguna consulta

#### Scenario: list_circuits con argumentos
- **WHEN** un cliente envía `list_circuits` con cualquier propiedad
- **THEN** la llamada se rechaza por validación

## MODIFIED Requirements

### Requirement: describe_circuit
`describe_circuit` SHALL recibir `{ circuit }` y devolver `id`, `description`, `namingNote` y la lista de tablas, como documentación de negocio para escribir SQL. Cada tabla confirmada MUST incluir `queryable: true`, `columns` y `notes`; cada tabla no confirmada MUST incluir `queryable: false`, `status` y `notQueryableReasons`, y nunca `columns`. `queryable` no es un permiso. Las `pendingColumns` se informan en ambos casos solo como documentación.

#### Scenario: Tabla consultable
- **WHEN** se describe un circuito con una tabla sin status restringido y con columnas confirmadas
- **THEN** esa tabla aparece con `queryable: true` y sus columnas confirmadas

#### Scenario: Tabla no consultable
- **WHEN** se describe un circuito con una tabla `needs_review`
- **THEN** esa tabla aparece con `queryable: false`, `notQueryableReasons` que incluye `needs_review` y sin `columns`

#### Scenario: Circuito no permitido
- **WHEN** un usuario describe un circuito existente que su rol no tiene
- **THEN** recibe un error `AUTHORIZATION_ERROR`

### Requirement: Formato de resultados y errores de tools
Toda tool SHALL devolver su resultado como un único contenido `text` con JSON. Ante cualquier error, la tool MUST devolver `isError: true` con contenido `{ "error": { "code", "message" } }`, donde `code` es uno de los códigos públicos definidos en `safe-errors`.

#### Scenario: Error de dominio
- **WHEN** `describe_circuit` pide un circuito que el rol no tiene
- **THEN** la respuesta tiene `isError: true` y `error.code = "AUTHORIZATION_ERROR"`

## REMOVED Requirements

### Requirement: Tools de lectura
**Reason**: Desaparecen `query_circuit` y el opt-in `sql: true`; lo reemplaza "Tools expuestas".
**Migration**: Ninguna para los clientes MCP: `query_sql` queda disponible para todo rol definido.

### Requirement: Inputs estrictos
**Reason**: Sus escenarios hablaban de `query_circuit`; lo reemplaza "Inputs estrictos sin base ni identidad", con la misma regla.
**Migration**: Ninguna.

### Requirement: query_circuit
**Reason**: El DSL agregaba fricción innecesaria; `query_sql` lo reemplaza.
**Migration**: Usar `query_sql` con el SQL equivalente.
