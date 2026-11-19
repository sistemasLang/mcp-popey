# Spec Delta

## MODIFIED Requirements

### Requirement: databaseKey solo server-side
La base de cada consulta SHALL ser siempre `UserContext.databaseKey`. `QuerySqlUseCase` MUST NOT tener otra forma de elegir base, y ningún input de tool puede aportar ni influir en ella.

#### Scenario: Dos tenants
- **WHEN** usuarios de los tenants `lang` y `cliente_b` envían el mismo SQL
- **THEN** cada uno recibe filas solo de su propia base

#### Scenario: databaseKey en el input
- **WHEN** un cliente envía `query_sql` con `databaseKey: "cliente_b"`
- **THEN** la llamada se rechaza por validación y no se ejecuta SQL
