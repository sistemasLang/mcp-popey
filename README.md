# MCP-Popey

Servidor MCP de consulta de solo lectura sobre la base de Popey ERP,
organizada por **circuitos de negocio** (venta, compras, stock, etc.).

## Estructura

```
config/circuits.yaml   # datos: qué circuitos existen, qué tablas tiene cada uno
src/circuits.py        # puerta de entrada a circuits.yaml (lo lee una vez, lo cachea)
src/db.py              # acceso a Postgres (pool, guardas de solo-lectura, chequeo de rol)
src/server.py          # servidor MCP: junta circuits.py + db.py en 3 tools
requirements.txt
```

`circuits.py` y `db.py` son independientes entre sí — ninguno de los dos sabe
que el otro existe. `server.py` es el único módulo que conoce a ambos.

## Requisitos

- Python 3.12+ (probado con esa versión; no se testeó en versiones anteriores).
- Acceso de red a una instancia de Postgres con el esquema de Popey ERP.
- **Un rol de Postgres genuinamente read-only** (ver [Seguridad](#seguridad-y-política-de-acceso) —
  el servidor se niega a arrancar si detecta que el rol tiene algún permiso
  de escritura).

## Instalación

```bash
cd "MCP-Popey"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

> Si `python3 -m venv` falla por falta de `ensurepip`/`python3-venv`
> (`ModuleNotFoundError: No module named 'ensurepip'`), instalá el paquete
> del sistema (`sudo apt install python3.12-venv` en Debian/Ubuntu) o
> bootstrapeá pip a mano dentro del venv con
> [`get-pip.py`](https://bootstrap.pypa.io/get-pip.py).

## Configuración (variables de entorno)

| Variable | Obligatoria | Default | Descripción |
|---|---|---|---|
| `PGHOST` | No | `localhost` | Host de Postgres |
| `PGPORT` | No | `5432` | Puerto de Postgres |
| `PGDATABASE` | **Sí** | — | Nombre de la base |
| `PGUSER` | **Sí** | — | Rol de conexión — **debe ser read-only**, ver abajo |
| `PGPASSWORD` | **Sí** | — | Contraseña del rol |
| `DB_POOL_MIN` | No | `1` | Conexiones mínimas del pool |
| `DB_POOL_MAX` | No | `5` | Conexiones máximas del pool |
| `DB_STATEMENT_TIMEOUT_MS` | No | `30000` | `statement_timeout` de sesión (ms), aplicado a cada conexión del pool al crearse |
| `DB_DEFAULT_ROW_LIMIT` | No | `1000` | `LIMIT` que se agrega automáticamente a una query que no trae uno |

Si falta alguna de las 3 obligatorias, el servidor no arranca y lo dice
explícitamente (no hay fallback silencioso a valores de `psycopg2`).

## Correr el servidor

```bash
export PGHOST=...
export PGDATABASE=...
export PGUSER=...
export PGPASSWORD=...

python src/server.py
```

(Equivalente: `cd src && python server.py` — la resolución de rutas internas
no depende del directorio desde el que se invoque.)

Corre sobre **stdio** por default (`mcp.run()`, transporte `"stdio"`): queda
esperando mensajes JSON-RPC por `stdin`/`stdout` — no es para ejecutar suelto
en una terminal y esperar ver algo, es para que lo levante un cliente MCP.
No usar `print()` en ningún cambio a este código: con stdio, `stdout` **es**
el canal del protocolo.

### Conectarlo a un cliente MCP

Ejemplo de configuración (Claude Desktop, Claude Code vía `.mcp.json`, u
otro cliente que use el mismo formato `mcpServers`):

```json
{
  "mcpServers": {
    "popey-erp": {
      "command": "/ruta/a/MCP-Popey/.venv/bin/python",
      "args": ["/ruta/a/MCP-Popey/src/server.py"],
      "env": {
        "PGHOST": "...",
        "PGDATABASE": "...",
        "PGUSER": "...",
        "PGPASSWORD": "..."
      }
    }
  }
}
```

## Las 3 tools

### `list_circuits()`
Sin parámetros. Devuelve `[{name, description}, ...]` — los circuitos de
negocio definidos en `circuits.yaml`.

### `query_circuit(circuito, sql, params=None)`
Ejecuta un **único `SELECT`** de solo lectura. `circuito` (ej. `"venta"`) es
contexto informativo, no una restricción de acceso — ver política abajo.
`params` son los parámetros de la query (lista para `%s`, dict para
`%(nombre)s`); nunca interpolar valores directo en `sql`.

Devuelve `{"rows": [...], "warnings": [...]}`.

### `get_circuit_schema(circuito)`
Junta la metadata de negocio de `circuits.yaml` (role, key_columns, source,
status, notes, pending_columns) con las columnas reales de Postgres
(`information_schema.columns`, acotado a las tablas del circuito) — pensado
para que el modelo sepa qué puede pedir antes de armar el `sql` de
`query_circuit`.

## Seguridad y política de acceso

Hay dos capas independientes, ninguna reemplaza a la otra:

### 1. El rol de Postgres (barrera primaria)

`PGUSER` **tiene que ser un rol read-only real** (`GRANT SELECT` únicamente).
El servidor no confía ciegamente en eso: al arrancar, `db.init_pool()`
verifica el rol contra Postgres (superusuario, GRANT de escritura propio o
de `PUBLIC`, ownership de alguna tabla, o `CREATE` sobre algún schema) y, si
encuentra cualquier permiso de escritura o DDL, **loguea `CRITICAL` y aborta
el arranque** — no levanta el servidor con la barrera primaria comprometida.

### 2. La guarda de código (segunda capa, defensa en profundidad)

Independientemente del rol, `db.py` valida cada SQL antes de mandarlo a
Postgres:
- tiene que empezar con `SELECT`;
- una sola sentencia (rechaza `;` interno — bloquea múltiples sentencias);
- sin palabras prohibidas en ningún lugar de la query (`INSERT`, `UPDATE`,
  `DELETE`, `DROP`, `ALTER`, `CREATE`, `pg_sleep`, `dblink`, etc.).

Un `DELETE`/`UPDATE` mandado a `query_circuit` se rechaza acá, en Python,
antes de llegar a la base — no depende de que Postgres tire un error de
permisos.

### `circuits.yaml` es informativo, no una barrera de acceso

Decisión explícita: el circuito pedido en `query_circuit` **nunca bloquea
qué se puede leer**. Tres situaciones generan un aviso en `warnings` pero la
query se ejecuta igual:

- la tabla no pertenece al circuito pedido (pertenece a otro, o a ninguno);
- la tabla está marcada `status: needs_review` en `circuits.yaml`;
- la tabla está marcada `status: legacy` en `circuits.yaml`.

**Única excepción bloqueante a esta política**: si `circuito` no es uno de
los circuitos existentes (`list_circuits()`), `query_circuit` y
`get_circuit_schema` rechazan antes de ejecutar nada. No es un problema de
status de una tabla — es la ausencia total de un circuito de referencia:
sin eso no hay contra qué avisar, no hay "role/notes" que citar en un
warning informativo. Por eso ahí sí se corta.

### Auditoría

Cada llamada a `query_circuit` que llega a ejecutarse loguea (vía el logger
`popey-mcp.server`, nivel `WARNING` si hubo algún aviso, `INFO` si no): el
circuito pedido, el SQL final ejecutado (con el `LIMIT` ya aplicado) y las
tablas que generaron warning. **Limitación conocida**: los intentos
rechazados por la guarda de código (SELECT-only) o que fallan contra
Postgres no quedan auditados — el log se emite justo antes del `return`, y
una excepción corta el flujo antes de llegar ahí.

## Troubleshooting

- **"Faltan variables de entorno obligatorias para conectar a Postgres"** —
  falta `PGDATABASE`, `PGUSER` o `PGPASSWORD`.
- **El servidor no arranca y loguea `CRITICAL` sobre permisos de
  escritura/DDL** — `PGUSER` no es read-only; corregir los `GRANT` del rol
  en Postgres (no hay forma de saltear este chequeo desde acá a propósito).
- **`ModuleNotFoundError` al importar `mcp`, `sqlglot` o `psycopg2`** —
  faltó `pip install -r requirements.txt` (o el venv no está activado).
