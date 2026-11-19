# Spec Delta

## MODIFIED Requirements

### Requirement: Sesiones de solo lectura
Cada conexión del pool SHALL abrirse con `default_transaction_read_only=on` y `statement_timeout = QUERY_SQL_TIMEOUT_MS` (default 30000 ms).

#### Scenario: Consulta lenta
- **WHEN** una consulta supera el timeout
- **THEN** PostgreSQL la cancela y el cliente recibe `QUERY_TIMEOUT`

#### Scenario: Sesión de escritura
- **WHEN** una sentencia intenta escribir fuera de una transacción explícita
- **THEN** PostgreSQL la rechaza porque la sesión es de solo lectura
