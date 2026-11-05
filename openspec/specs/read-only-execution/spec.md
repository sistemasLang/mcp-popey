# read-only-execution Specification

## Purpose
Ejecuta el SQL compilado en PostgreSQL con varias barreras de solo lectura (sesión, transacción, rol de base) y un límite de tiempo, devolviendo resultados con tipos estables.

## Requirements

### Requirement: Transacción READ ONLY siempre revertida
Cada consulta SHALL ejecutarse dentro de `BEGIN READ ONLY`, con `SET LOCAL statement_timeout` tomado de la configuración del servidor, y terminar siempre con `ROLLBACK`, haya éxito o error.

#### Scenario: Intento de escritura
- **WHEN** por cualquier vía llegara a ejecutarse una sentencia de escritura
- **THEN** PostgreSQL la rechaza por estar en una transacción de solo lectura

#### Scenario: Conexión rota
- **WHEN** falla el `ROLLBACK` o el error no viene del servidor PostgreSQL
- **THEN** el cliente se libera como roto y el pool no lo reutiliza

### Requirement: Sesiones de solo lectura
Cada conexión del pool SHALL abrirse con `default_transaction_read_only=on` y `statement_timeout = QUERY_TIMEOUT_MS` (default 10000 ms).

#### Scenario: Consulta lenta
- **WHEN** una consulta supera el timeout
- **THEN** PostgreSQL la cancela y el cliente recibe `QUERY_TIMEOUT`

### Requirement: Rol de base mcp_popey_ro
Cada base de tenant SHALL usar el rol `mcp_popey_ro`, creado con `scripts/create_readonly_role.sql`, con solo `CONNECT`, `USAGE` y `SELECT` (más default privileges de SELECT para tablas futuras) sobre los schemas que usan los circuitos, y `default_transaction_read_only = on`. El rol MUST NOT tener INSERT, UPDATE, DELETE, TRUNCATE ni privilegios de DDL, y el script MUST ser idempotente.

#### Scenario: Re-ejecución del script
- **WHEN** se corre el script sobre una base donde el rol ya existe
- **THEN** actualiza la contraseña y los grants sin error

#### Scenario: Escritura directa con el rol
- **WHEN** alguien se conecta como `mcp_popey_ro` e intenta un INSERT
- **THEN** PostgreSQL lo rechaza

### Requirement: Tipos de resultado estables
Las columnas `DATE` SHALL devolverse como string `YYYY-MM-DD`, sin convertirse a `Date` local, para evitar el corrimiento de día en UTC-3.

#### Scenario: Fecha de factura
- **WHEN** se lee una columna DATE con valor `2026-10-01`
- **THEN** el resultado contiene exactamente `"2026-10-01"`

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
