# Spec Delta

## MODIFIED Requirements

### Requirement: Ventana deslizante por usuario
`query_circuit` y `query_sql` SHALL consumir una unidad de un mismo limitador de ventana deslizante por `userId` (no por IP), con `RATE_LIMIT_MAX_REQUESTS` (default 30) por `RATE_LIMIT_WINDOW_MS` (default 60000), antes de validar o ejecutar la consulta. `list_circuits` y `describe_circuit` no consumen cuota.

#### Scenario: Cuota excedida
- **WHEN** un usuario hace la consulta número 31 dentro de la misma ventana de 60 s
- **THEN** recibe `RATE_LIMIT_EXCEEDED` con el mensaje "Rate limit exceeded; retry in Ns" y no se ejecuta SQL

#### Scenario: Usuarios independientes
- **WHEN** un usuario agota su cuota
- **THEN** otro usuario del mismo tenant puede seguir consultando

#### Scenario: Cuota compartida entre tools
- **WHEN** un usuario hizo 20 llamadas a `query_circuit` y 10 a `query_sql` en la misma ventana
- **THEN** la siguiente llamada a cualquiera de las dos recibe `RATE_LIMIT_EXCEEDED`
