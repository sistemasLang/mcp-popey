# Spec Delta

## ADDED Requirements

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
