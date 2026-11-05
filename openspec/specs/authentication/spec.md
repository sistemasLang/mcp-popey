# authentication Specification

## Purpose
Convierte el token Bearer de cada request HTTP en un `UserContext` inmutable construido del lado del servidor, que es la única fuente de identidad, rol y tenant para las tools.

## Requirements

### Requirement: Token Bearer obligatorio
Cada request a `/mcp` SHALL traer el header `Authorization: Bearer <token>`. El token MUST cumplir el formato `^[A-Za-z0-9_-]{32,256}$`; cualquier otro valor se rechaza antes de consultar el repositorio de usuarios.

#### Scenario: Header ausente
- **WHEN** el request no tiene header `Authorization`
- **THEN** la autenticación falla con `AuthenticationError` y el cliente recibe 401

#### Scenario: Token con formato inválido
- **WHEN** el token tiene menos de 32 caracteres o caracteres fuera de `[A-Za-z0-9_-]`
- **THEN** la autenticación falla sin buscar el hash en `users.yaml`

### Requirement: Verificación por hash SHA-256
El servidor SHALL guardar y comparar solo el SHA-256 hex del token, nunca el token en claro. La comparación MUST usar `timingSafeEqual` y recorrer todos los registros sin salida temprana para mantener tiempo uniforme.

#### Scenario: Token desconocido
- **WHEN** el SHA-256 del token no coincide con ningún registro
- **THEN** la autenticación falla con el mensaje genérico `Invalid bearer token`

### Requirement: Usuario habilitado
La autenticación SHALL fallar si el usuario asociado al token no existe o tiene `enabled: false`, con el mismo mensaje genérico que un token inválido.

#### Scenario: Usuario deshabilitado
- **WHEN** un token válido pertenece a un usuario con `enabled: false`
- **THEN** el cliente recibe 401 como si el token no existiera

### Requirement: UserContext server-side e inmutable
Tras autenticar, el servidor SHALL construir un `UserContext` congelado con `userId`, `role` y `databaseKey` del registro del usuario, y lo MUST inyectar a las tools por closure. Ninguna tool puede leer identidad, rol ni base de su input.

#### Scenario: Intento de suplantar el tenant
- **WHEN** un cliente autenticado como tenant `lang` envía `databaseKey: "otro"` en una tool
- **THEN** el input se rechaza por validación estricta y la consulta, si la hubiera, igual usaría `lang`

### Requirement: Recarga en caliente de usuarios
El repositorio `users.yaml` SHALL releerse cuando cambia su `mtime`, de modo que altas, rotaciones y bajas hechas por la CLI apliquen sin reiniciar el servidor. Un `users.yaml` estructuralmente inválido MUST producir `ConfigurationError`.

#### Scenario: Baja sin reinicio
- **WHEN** la CLI deshabilita a un usuario mientras el servidor corre
- **THEN** el siguiente request con su token recibe 401

#### Scenario: Archivo inexistente
- **WHEN** `users.yaml` no existe
- **THEN** el repositorio se comporta como vacío y todo token es inválido
