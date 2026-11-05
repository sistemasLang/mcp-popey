# Spec Delta

## MODIFIED Requirements

### Requirement: Rol de base mcp_popey_ro
Cada base de tenant SHALL usar el rol `mcp_popey_ro`, creado con `scripts/create_readonly_role.sql`, con solo `CONNECT`, `USAGE` y `SELECT` (más default privileges de SELECT para tablas futuras) sobre los schemas que usan los circuitos, y `default_transaction_read_only = on`. El rol MUST NOT tener INSERT, UPDATE, DELETE, TRUNCATE ni privilegios de DDL, y el script MUST ser idempotente.

#### Scenario: Re-ejecución del script
- **WHEN** se corre el script sobre una base donde el rol ya existe
- **THEN** actualiza la contraseña y los grants sin error

#### Scenario: Escritura directa con el rol
- **WHEN** alguien se conecta como `mcp_popey_ro` e intenta un INSERT
- **THEN** PostgreSQL lo rechaza

## ADDED Requirements

### Requirement: Columnas sensibles de seguridad protegidas en la base
El rol `mcp_popey_ro` SHALL tener `USAGE` sobre `seguridad` y `SELECT` solo sobre las columnas no sensibles de `seguridad.usuario`, `seguridad.usuarioxrol`, `seguridad.rol` y `seguridad.view_usuario`. Credenciales, hashes, 2FA, estado de bloqueo y `dfechanacimiento` MUST quedar sin grant.

#### Scenario: Columnas permitidas
- **WHEN** se ejecuta `SELECT nusuario, vnombre, vapellido FROM seguridad.usuario`
- **THEN** PostgreSQL devuelve las filas

#### Scenario: Contraseña
- **WHEN** se ejecuta `SELECT vpassword FROM seguridad.usuario`
- **THEN** PostgreSQL responde permiso denegado (42501)

#### Scenario: SELECT asterisco
- **WHEN** se ejecuta `SELECT * FROM seguridad.usuario`
- **THEN** PostgreSQL responde permiso denegado porque incluye columnas sin grant
