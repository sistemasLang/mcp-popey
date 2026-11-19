# Spec Delta

## ADDED Requirements

### Requirement: Modelo de usuario con identidades externas
Cada usuario SHALL tener un `id` interno (UUID), `kind` (`human` o `service`), `label`, `admin`, `enabled`, `createdAt` y una lista de identidades `{ issuer, subject }`. `role` y `databaseKey` MUST estar ambos presentes o ambos ausentes. Una cuenta `kind: service` MUST NOT tener `admin: true`. Un par `(issuer, subject)` MUST pertenecer a un solo usuario.

#### Scenario: Rol sin tenant
- **WHEN** se intenta guardar un usuario con `role: ventas` y sin `databaseKey`
- **THEN** la operación falla con `UserManagementError` y no se escribe nada

#### Scenario: Cuenta de servicio admin
- **WHEN** se intenta marcar como `admin: true` a una cuenta `kind: service`
- **THEN** la operación falla y la cuenta queda como estaba

#### Scenario: Identidad duplicada
- **WHEN** se intenta vincular a un segundo usuario un `(issuer, subject)` que ya está vinculado
- **THEN** la operación falla sin modificar el archivo

### Requirement: Invitación de personas
Invitar a una persona SHALL crear su usuario en el IdP mediante `IdentityProviderPort.createHuman(email)`, sin que el admin defina ni conozca su contraseña, guardar en el repositorio el usuario `kind: human` con la identidad devuelta por el IdP y devolver un link para elegir contraseña (`issuePasswordLink`) una única vez. Ni el IdP ni el servidor MUST enviar mails: el admin entrega el link por su cuenta. El email MUST normalizarse a minúsculas y validarse como dirección de correo.

#### Scenario: Invitación exitosa
- **WHEN** un admin invita a `Juan@Empresa.com` con rol `ventas` y tenant `lang`
- **THEN** el IdP recibe `juan@empresa.com` sin envío de mail, el repositorio guarda el usuario con su `subject` y la respuesta trae `passwordLink` con `url` y `expiresAt`

#### Scenario: Falla al emitir el link
- **WHEN** el IdP crea al usuario y el repositorio lo guarda, pero la emisión del link falla
- **THEN** el usuario queda creado sin contraseña conocida y la respuesta indica que hay que regenerar el link

#### Scenario: Email ya provisionado
- **WHEN** se invita a un email que ya tiene un usuario en el repositorio
- **THEN** la operación falla con `UserManagementError` y no se llama al IdP

#### Scenario: Falla al guardar después de crear en el IdP
- **WHEN** el IdP crea al usuario pero la escritura de `users.yaml` falla
- **THEN** se bloquea al usuario en el IdP, se registra el error interno y la persona no obtiene acceso

### Requirement: Link para elegir contraseña
El link SHALL ser un *password change ticket* del IdP con vida `PASSWORD_LINK_TTL_SECONDS`, que no marca el email como verificado. Un admin SHALL poder pedir un link nuevo para cualquier persona habilitada; ese es también el camino para recuperar una contraseña olvidada. El link MUST mostrarse una sola vez y MUST NOT persistirse en el servidor, escribirse en logs ni aparecer en la auditoría.

#### Scenario: Regenerar link
- **WHEN** un admin pide un link nuevo para una persona habilitada
- **THEN** recibe una URL nueva con su `expiresAt` y `users.yaml` no cambia

#### Scenario: Link para una cuenta de servicio
- **WHEN** un admin pide un link para una cuenta `kind: service`
- **THEN** la operación falla y no se llama al IdP

#### Scenario: Link para una persona deshabilitada
- **WHEN** un admin pide un link para una persona con `enabled: false`
- **THEN** la operación falla y no se llama al IdP

### Requirement: Cuentas de servicio M2M
Crear una cuenta de servicio SHALL crear en el IdP una aplicación con grant `client_credentials` autorizada solo para `MCP_RESOURCE_URL`, guardar el usuario `kind: service` con identidad `<client_id>@clients`, y devolver `clientId` y `clientSecret` una única vez. El `clientSecret` MUST NOT persistirse en el servidor, escribirse en logs ni aparecer en la auditoría. Rotar SHALL devolver un secreto nuevo una única vez e invalidar el anterior en el IdP.

#### Scenario: Alta de la cuenta de n8n
- **WHEN** un admin crea la cuenta de servicio `n8n-reportes` con rol `general` y tenant `lang`
- **THEN** la respuesta trae `clientId` y `clientSecret`, y `users.yaml` no contiene el secreto

#### Scenario: Secreto no recuperable
- **WHEN** un admin pide el detalle de una cuenta de servicio ya creada
- **THEN** la respuesta no incluye ningún secreto

#### Scenario: Cuenta de servicio sin rol
- **WHEN** se intenta crear una cuenta de servicio sin `role` o sin `databaseKey`
- **THEN** la operación falla y no se crea nada en el IdP

### Requirement: Deshabilitar usuarios
Deshabilitar SHALL poner `enabled: false` en el repositorio, sin borrar el registro, y además bloquear a la persona en el IdP o revocar el *client grant* de la cuenta de servicio. El corte MUST ser inmediato por el repositorio, aunque la llamada al IdP falle.

#### Scenario: IdP caído durante la baja
- **WHEN** un admin deshabilita a un usuario y la llamada al IdP falla
- **THEN** el usuario queda con `enabled: false`, sus requests reciben 403 y el error del IdP se informa al admin y se registra

#### Scenario: Rehabilitar
- **WHEN** un admin vuelve a habilitar a una persona
- **THEN** se desbloquea en el IdP y su próximo login funciona

## MODIFIED Requirements

### Requirement: Validación de rol y tenant en el alta
Toda alta o modificación SHALL rechazar un `role` que no exista en `circuit-access.yaml` y un `databaseKey` que no esté en `DATABASE_KEYS`, indicando los valores conocidos, antes de llamar al IdP.

#### Scenario: Rol inexistente
- **WHEN** un admin asigna el rol `auditor` y ese rol no está en `circuit-access.yaml`
- **THEN** la operación falla mostrando los roles conocidos y no se llama al IdP

#### Scenario: Tenant inexistente
- **WHEN** un admin asigna el `databaseKey` `otro`, que no está en `DATABASE_KEYS`
- **THEN** la operación falla mostrando las claves configuradas

#### Scenario: Política vacía
- **WHEN** `circuit-access.yaml` no define roles
- **THEN** ninguna persona ni cuenta de servicio puede recibir acceso a `/mcp`; solo se pueden gestionar admins sin rol

### Requirement: Persistencia segura de users.yaml
La escritura de `users.yaml` SHALL ser atómica (archivo temporal + `rename`), dejar el archivo con permisos `0600` y declarar `version: 2`. El archivo MUST NOT contener contraseñas, secretos de clientes ni tokens. En Docker, `./data` MUST montarse como bind mount para que los usuarios sobrevivan reinicios y `docker volume prune`.

#### Scenario: Reinicio del contenedor
- **WHEN** el contenedor se recrea
- **THEN** los usuarios existentes siguen autenticando con sus identidades

#### Scenario: Contenido del archivo
- **WHEN** se inspecciona `users.yaml` después de crear una persona y una cuenta de servicio
- **THEN** solo contiene ids, identidades, `label`, rol, tenant y flags

## REMOVED Requirements

### Requirement: Gestión solo por CLI
**Reason**: La gestión pasa a la API de administración y al panel web (capability `admin-panel`), protegidos por OAuth y restringidos a admins.
**Migration**: Usar el panel. `dist/cli/create-user.js` y el script `create-user` se eliminan.

### Requirement: Alta de usuario
**Reason**: El servidor ya no genera tokens. Las personas se invitan vía IdP y las cuentas de servicio son apps M2M.
**Migration**: Ver "Invitación de personas", "Link para elegir contraseña" y "Cuentas de servicio M2M".

### Requirement: Rotación y baja
**Reason**: Sin tokens propios no hay nada que rotar para las personas. La baja pasa al panel.
**Migration**: Ver "Deshabilitar usuarios" y la rotación de secreto en "Cuentas de servicio M2M".
