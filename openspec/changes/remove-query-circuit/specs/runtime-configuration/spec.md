# Spec Delta

## MODIFIED Requirements

### Requirement: Variables de entorno validadas
La configuración SHALL leerse de variables de entorno (con `.env` opcional en el directorio de trabajo; las variables reales tienen prioridad) y validarse con Zod. Son obligatorias `AUTH0_DOMAIN`, `MCP_RESOURCE_URL` (URL https absoluta), `ADMIN_API_AUDIENCE`, `AUTH0_MGMT_CLIENT_ID` y `AUTH0_MGMT_CLIENT_SECRET`. Son opcionales `AUTH0_DB_CONNECTION` (default `Username-Password-Authentication`), `BOOTSTRAP_ADMIN_EMAILS` (lista separada por comas de emails válidos), `PASSWORD_LINK_TTL_SECONDS` (entero entre 300 y 604800, default 86400), `QUERY_SQL_MAX_ROWS` (default 1000) y `QUERY_SQL_TIMEOUT_MS` (default 30000). Un valor inválido o faltante MUST impedir el arranque. Las variables del DSL eliminado (`QUERY_DEFAULT_ROWS`, `QUERY_MAX_ROWS`, `QUERY_TIMEOUT_MS`, etc.) se ignoran. Los valores de secretos MUST NOT aparecer en mensajes de error ni en logs.

#### Scenario: Defaults
- **WHEN** no se define ninguna variable opcional
- **THEN** se usan `MCP_HOST=127.0.0.1`, `MCP_PORT=3030`, `CIRCUITS_FILE=config/circuits.yaml`, `CIRCUIT_ACCESS_FILE=config/circuit-access.yaml`, `USERS_FILE=data/users.yaml`, `AUTH0_DB_CONNECTION=Username-Password-Authentication`, `PASSWORD_LINK_TTL_SECONDS=86400`, `QUERY_SQL_MAX_ROWS=1000` y `QUERY_SQL_TIMEOUT_MS=30000`

#### Scenario: Vida del link fuera de rango
- **WHEN** `PASSWORD_LINK_TTL_SECONDS=2592000` (30 días)
- **THEN** el arranque falla

#### Scenario: Límites incoherentes
- **WHEN** el entorno todavía define `QUERY_DEFAULT_ROWS=600` y `QUERY_MAX_ROWS=500`
- **THEN** el servidor arranca y las ignora

#### Scenario: Límite de query_sql inválido
- **WHEN** `QUERY_SQL_MAX_ROWS=0`
- **THEN** el arranque falla

#### Scenario: Falta configuración de Auth0
- **WHEN** no está definido `AUTH0_DOMAIN` o `MCP_RESOURCE_URL`
- **THEN** el arranque falla indicando qué variable falta

#### Scenario: Recurso sin https
- **WHEN** `MCP_RESOURCE_URL=http://mcp.empresa.com/mcp`
- **THEN** el arranque falla

#### Scenario: Secreto inválido
- **WHEN** `AUTH0_MGMT_CLIENT_SECRET` está vacío
- **THEN** el arranque falla y el mensaje nombra la variable sin mostrar valores
