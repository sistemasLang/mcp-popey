# user-management Specification

## Purpose
Alta, rotación de token y baja de usuarios del MCP exclusivamente por consola (`dist/cli/create-user.js`), persistiendo en `users.yaml` solo el hash del token.

## Requirements

### Requirement: Gestión solo por CLI
La gestión de usuarios SHALL hacerse únicamente con la CLI `create-user`. El servidor MUST NOT exponer endpoints HTTP ni tools MCP para crear, modificar o listar usuarios.

#### Scenario: Sin endpoint de usuarios
- **WHEN** un cliente busca una tool o ruta para gestionar usuarios
- **THEN** no existe ninguna

### Requirement: Alta de usuario
`create-user --username <u> --role <r> --database-key <k>` SHALL crear un usuario con `id` UUID, `enabled: true`, `createdAt` ISO y `tokenSha256`, e imprimir el token en claro una única vez. El username MUST normalizarse a minúsculas y cumplir `^[a-z0-9][a-z0-9._-]{1,63}$`.

#### Scenario: Alta exitosa
- **WHEN** se crea un usuario con rol y databaseKey válidos
- **THEN** `users.yaml` guarda el registro sin el token y la consola muestra el token una sola vez

#### Scenario: Username duplicado
- **WHEN** se intenta crear un usuario que ya existe sin `--rotate`
- **THEN** la CLI falla con código 1 y no modifica el archivo

### Requirement: Validación de rol y tenant en el alta
La CLI SHALL rechazar un `--role` que no exista en `circuit-access.yaml` y un `--database-key` que no esté en `DATABASE_KEYS`, listando los valores conocidos.

#### Scenario: Rol inexistente
- **WHEN** se pasa `--role auditor` y ese rol no está en `circuit-access.yaml`
- **THEN** la CLI falla mostrando los roles conocidos

#### Scenario: Política vacía
- **WHEN** `circuit-access.yaml` no define roles
- **THEN** ningún alta es posible

### Requirement: Rotación y baja
`--rotate` SHALL generar un token nuevo conservando `id`, rol y databaseKey salvo que se indiquen otros. `--disable` SHALL poner `enabled: false` sin borrar el registro. Ambas opciones MUST ser mutuamente excluyentes y requerir un usuario existente.

#### Scenario: Rotación
- **WHEN** se rota el token de un usuario existente
- **THEN** el token anterior deja de autenticar y el nuevo se muestra una vez

#### Scenario: Flags incompatibles
- **WHEN** se pasan `--rotate` y `--disable` juntos
- **THEN** la CLI falla sin modificar nada

### Requirement: Persistencia segura de users.yaml
La escritura de `users.yaml` SHALL ser atómica (archivo temporal + `rename`) y dejar el archivo con permisos `0600`. En Docker, `./data` MUST montarse como bind mount para que los usuarios sobrevivan reinicios y `docker volume prune`.

#### Scenario: Reinicio del contenedor
- **WHEN** el contenedor se recrea
- **THEN** los usuarios existentes siguen autenticando
