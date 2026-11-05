# role-authorization Specification

## Purpose
Decide qué circuitos puede ver y consultar cada rol, a partir de `config/circuit-access.yaml`, con deny by default.

## Requirements

### Requirement: Política rol → circuitos
`circuit-access.yaml` SHALL definir `roles.<rol>.circuits: [ids]`. Un rol MUST cumplir `^[a-z0-9_]{1,64}$`. Un rol que no figura en el archivo no tiene acceso a ningún circuito.

#### Scenario: Rol no listado
- **WHEN** un usuario tiene un rol ausente de `circuit-access.yaml`
- **THEN** `list_circuits` devuelve vacío y toda otra tool falla con `AUTHORIZATION_ERROR`

#### Scenario: Archivo sin roles
- **WHEN** `roles` está vacío o es null
- **THEN** el servidor arranca y nadie accede a nada

### Requirement: Circuitos desconocidos impiden arrancar
Si un rol referencia un circuito que no existe en `circuits.yaml`, el servidor SHALL negarse a arrancar con `ConfigurationError`, para que un typo no se convierta en "sin acceso" silencioso.

#### Scenario: Typo en un circuito
- **WHEN** un rol lista `ventas` y el circuito real es `venta`
- **THEN** el arranque falla nombrando el circuito desconocido

### Requirement: Permisos definidos por el negocio
Los permisos reales SHALL definirlos el negocio; `circuit-access.example.yaml` es solo ejemplo de formato. Un agente MUST NOT ampliar ni inventar permisos sin un pedido explícito.

#### Scenario: Propuesta que necesita un permiso nuevo
- **WHEN** un change requiere que un rol acceda a otro circuito
- **THEN** la propuesta lo declara y el cambio en `circuit-access.yaml` se aprueba explícitamente

### Requirement: Autorización de tabla
Consultar una tabla SHALL requerir, en orden: que el circuito exista, que el rol tenga acceso, que la tabla pertenezca al circuito y que la tabla sea consultable.

#### Scenario: Circuito inexistente
- **WHEN** se consulta un circuito que no existe
- **THEN** falla con `CIRCUIT_NOT_FOUND`

#### Scenario: Tabla de otro circuito
- **WHEN** se pide en el circuito `venta` una tabla que solo pertenece a `compras`
- **THEN** falla con `TABLE_NOT_ALLOWED`

#### Scenario: Tabla no consultable
- **WHEN** se consulta una tabla con razones de denegación
- **THEN** falla con `TABLE_NOT_ALLOWED` incluyendo las razones

### Requirement: Habilitación de SQL por rol
`circuit-access.yaml` SHALL aceptar `roles.<rol>.sql` booleano, con `false` por defecto. Solo los roles con `sql: true` acceden a `query_sql`. Habilitarlo para un rol MUST ser una decisión explícita del negocio, igual que asignar circuitos.

#### Scenario: Rol sin flag
- **WHEN** un rol no declara `sql`
- **THEN** sus usuarios no tienen acceso a `query_sql`

#### Scenario: Valor inválido
- **WHEN** un rol declara `sql: "si"`
- **THEN** el servidor no arranca por configuración inválida

### Requirement: Alcance de los permisos por circuito
Los permisos por circuito SHALL acotar únicamente a `list_circuits`, `describe_circuit` y `query_circuit`. Un usuario con `sql: true` MUST poder leer con `query_sql` todo lo que permita el rol de base del tenant, aunque pertenezca a circuitos que su rol no tiene.

#### Scenario: Rol con SQL y un solo circuito
- **WHEN** un rol con `sql: true` y solo el circuito `venta` consulta por `query_sql` una tabla del circuito `compras`
- **THEN** la consulta se ejecuta si el rol de base tiene `SELECT` sobre esa tabla

#### Scenario: Mismo rol por el DSL
- **WHEN** ese mismo usuario consulta la tabla de `compras` por `query_circuit`
- **THEN** recibe `AUTHORIZATION_ERROR`
