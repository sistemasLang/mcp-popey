# runtime-configuration Specification

## Purpose
Define cómo se configura, arranca, despliega y apaga el servidor: variables de entorno, archivos de configuración, contenedor Docker y healthcheck.

## Requirements

### Requirement: Variables de entorno validadas
La configuración SHALL leerse de variables de entorno (con `.env` opcional en el directorio de trabajo; las variables reales tienen prioridad) y validarse con Zod. Un valor inválido, o `QUERY_DEFAULT_ROWS > QUERY_MAX_ROWS`, MUST impedir el arranque.

#### Scenario: Defaults
- **WHEN** no se define ninguna variable opcional
- **THEN** se usan `MCP_HOST=127.0.0.1`, `MCP_PORT=3000`, `CIRCUITS_FILE=config/circuits.yaml`, `CIRCUIT_ACCESS_FILE=config/circuit-access.yaml`, `USERS_FILE=data/users.yaml` y los límites de consulta por defecto

#### Scenario: Límites incoherentes
- **WHEN** `QUERY_DEFAULT_ROWS=600` y `QUERY_MAX_ROWS=500`
- **THEN** el arranque falla

### Requirement: Arranque fail-fast
El servidor SHALL cargar `circuits.yaml`, `circuit-access.yaml` y el registro de bases antes de abrir el puerto, y MUST terminar con código 1 ante cualquier error estructural. Al arrancar SHALL informar en stderr la URL, la cantidad de circuitos y de roles, y las claves de base (sin datos de conexión).

#### Scenario: Configuración rota
- **WHEN** alguno de los archivos de configuración es inválido
- **THEN** el proceso termina sin escuchar en el puerto

### Requirement: Apagado ordenado
Ante `SIGINT` o `SIGTERM` el servidor SHALL dejar de aceptar conexiones, cerrar todos los pools de PostgreSQL y terminar con código 0.

#### Scenario: docker stop
- **WHEN** el contenedor recibe SIGTERM
- **THEN** los pools se cierran antes de que el proceso termine

### Requirement: Despliegue en Docker
La imagen SHALL construirse en varias etapas sobre `node:22-bookworm-slim`, correr como usuario `node` y escuchar en `0.0.0.0:3030` dentro del contenedor. Compose MUST publicar solo en `127.0.0.1:3030`, montar `./config` como read-only y `./data` como bind mount, y permitir llegar a un PostgreSQL del host vía `host.docker.internal`.

#### Scenario: Exposición de red
- **WHEN** el contenedor está corriendo
- **THEN** el puerto 3030 solo es accesible desde localhost del host

### Requirement: Healthcheck
El healthcheck SHALL considerar sano al servidor cuando `GET /mcp` sin token responde 401.

#### Scenario: Servidor arriba
- **WHEN** el healthcheck pide `/mcp` sin token
- **THEN** recibe 401 y marca el contenedor como healthy
