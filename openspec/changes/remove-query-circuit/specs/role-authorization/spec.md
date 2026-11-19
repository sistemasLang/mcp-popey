# Spec Delta

## MODIFIED Requirements

### Requirement: Política rol → circuitos
`circuit-access.yaml` SHALL definir `roles.<rol>.circuits: [ids]`, los circuitos que el rol ve en `list_circuits` y `describe_circuit`. Un rol MUST cumplir `^[a-z0-9_]{1,64}$`. Un rol que no figura en el archivo no tiene acceso a ningún circuito ni a `query_sql`.

#### Scenario: Rol no listado
- **WHEN** un usuario tiene un rol ausente de `circuit-access.yaml`
- **THEN** `list_circuits` devuelve vacío, `describe_circuit` falla con `AUTHORIZATION_ERROR` y `query_sql` no está disponible

#### Scenario: Archivo sin roles
- **WHEN** `roles` está vacío o es null
- **THEN** el servidor arranca y nadie accede a nada

#### Scenario: Flag sql remanente
- **WHEN** un rol todavía declara `sql: true`
- **THEN** el servidor no arranca por configuración inválida

## ADDED Requirements

### Requirement: Los circuitos solo acotan el catálogo
Los permisos por circuito SHALL acotar únicamente a `list_circuits` y `describe_circuit`. Todo usuario con un rol definido MUST poder leer con `query_sql` todo lo que permita el rol de base del tenant, aunque pertenezca a circuitos que su rol no tiene. No hay limitación de tablas por rol en el servidor.

#### Scenario: Rol con un solo circuito
- **WHEN** un rol con solo el circuito `venta` consulta por `query_sql` una tabla del circuito `compras`
- **THEN** la consulta se ejecuta si el rol de base tiene `SELECT` sobre esa tabla

#### Scenario: Rol de base sin grant
- **WHEN** cualquier rol consulta por `query_sql` una columna sin grant para `mcp_popey_ro`
- **THEN** recibe `AUTHORIZATION_ERROR` con `sqlState: "42501"`

## REMOVED Requirements

### Requirement: Autorización de tabla
**Reason**: Solo aplicaba a `query_circuit`, que se elimina.
**Migration**: Ninguna; lo que se puede leer lo deciden los grants de `mcp_popey_ro`.

### Requirement: Habilitación de SQL por rol
**Reason**: Decisión del negocio: por ahora no hay limitación por rol; `query_sql` es la única vía de consulta.
**Migration**: Quitar `sql:` de `circuit-access.yaml`. Todo rol definido usa `query_sql`.

### Requirement: Alcance de los permisos por circuito
**Reason**: Sus escenarios comparaban `query_sql` con el DSL eliminado; lo reemplaza "Los circuitos solo acotan el catálogo".
**Migration**: Ninguna.
