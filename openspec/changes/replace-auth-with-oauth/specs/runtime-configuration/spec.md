# Spec Delta

## MODIFIED Requirements

### Requirement: Variables de entorno validadas
La configuración SHALL leerse de variables de entorno (con `.env` opcional en el directorio de trabajo; las variables reales tienen prioridad) y validarse con Zod. Son obligatorias `AUTH0_DOMAIN`, `MCP_RESOURCE_URL` (URL https absoluta), `ADMIN_API_AUDIENCE`, `AUTH0_MGMT_CLIENT_ID` y `AUTH0_MGMT_CLIENT_SECRET`. Son opcionales `AUTH0_DB_CONNECTION` (default `Username-Password-Authentication`), `BOOTSTRAP_ADMIN_EMAILS` (lista separada por comas de emails válidos) y `PASSWORD_LINK_TTL_SECONDS` (entero entre 300 y 604800, default 86400). Un valor inválido o faltante, o `QUERY_DEFAULT_ROWS > QUERY_MAX_ROWS`, MUST impedir el arranque. Los valores de secretos MUST NOT aparecer en mensajes de error ni en logs.

#### Scenario: Defaults
- **WHEN** no se define ninguna variable opcional
- **THEN** se usan `MCP_HOST=127.0.0.1`, `MCP_PORT=3030`, `CIRCUITS_FILE=config/circuits.yaml`, `CIRCUIT_ACCESS_FILE=config/circuit-access.yaml`, `USERS_FILE=data/users.yaml`, `AUTH0_DB_CONNECTION=Username-Password-Authentication`, `PASSWORD_LINK_TTL_SECONDS=86400` y los límites de consulta por defecto

#### Scenario: Vida del link fuera de rango
- **WHEN** `PASSWORD_LINK_TTL_SECONDS=2592000` (30 días)
- **THEN** el arranque falla

#### Scenario: Límites incoherentes
- **WHEN** `QUERY_DEFAULT_ROWS=600` y `QUERY_MAX_ROWS=500`
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

### Requirement: Arranque fail-fast
El servidor SHALL cargar `circuits.yaml`, `circuit-access.yaml`, `users.yaml` (formato v2) y el registro de bases, y ejecutar el bootstrap de admins cuando corresponda, antes de abrir el puerto. MUST terminar con código 1 ante cualquier error estructural o ante una falla del IdP durante el bootstrap. Al arrancar SHALL informar en stderr la URL, la cantidad de circuitos, de roles y de usuarios, el issuer de Auth0 y las claves de base (sin datos de conexión ni secretos).

#### Scenario: Configuración rota
- **WHEN** alguno de los archivos de configuración es inválido
- **THEN** el proceso termina sin escuchar en el puerto

#### Scenario: users.yaml del formato anterior
- **WHEN** `users.yaml` está en formato v1
- **THEN** el proceso termina sin escuchar en el puerto

## ADDED Requirements

### Requirement: Exposición por nginx
El sitio nginx SHALL enrutar al proceso solo `/mcp`, `/.well-known/oauth-protected-resource` (con y sin sufijo `/mcp`) y `/admin/api/`, servir el panel compilado como estático en `/admin/` y responder 404 en todo lo demás.

#### Scenario: Descubrimiento a través del proxy
- **WHEN** un cliente pide `https://<DOMINIO>/.well-known/oauth-protected-resource/mcp`
- **THEN** recibe la metadata del recurso

#### Scenario: Ruta no publicada
- **WHEN** alguien pide `https://<DOMINIO>/admin/api-internal` o `/data/users.yaml`
- **THEN** recibe 404
