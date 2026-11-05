"""server.py — servidor MCP de Popey.

Es el único módulo que conoce a la vez circuits.py y db.py; ninguno de los
dos se conoce entre sí (circuits.py no sabe que existe Postgres, db.py no
sabe que existen circuitos). Acá se juntan para exponer 3 tools:

  - list_circuits      — lista los circuitos de negocio (circuits.py).
  - query_circuit      — ejecuta un SELECT de solo lectura (db.py), usando
                          circuits.py solo para AVISAR (nunca bloquear) sobre
                          tablas fuera del circuito o marcadas
                          needs_review/legacy.
  - get_circuit_schema — junta la metadata de negocio de circuits.py con las
                          columnas reales de Postgres (db.py) para que el
                          modelo pueda armar el SQL de query_circuit.

Política de warnings (decidida explícitamente, no es el default de nadie):
circuits.yaml es informativo, no una barrera de acceso. Ni "la tabla no
pertenece a este circuito" ni "está needs_review/legacy" bloquean la
ejecución — se devuelven como texto en `warnings` junto a los datos. La
única barrera real de acceso es la transacción READ ONLY que impone db.py
en Postgres + las guardas de código en db.py (solo SELECT, una sentencia,
sin palabras prohibidas) — ver docstring de db.py.

ÚNICA EXCEPCIÓN bloqueante a esa política: si `circuito` no es uno de los
circuitos existentes, query_circuit y get_circuit_schema rechazan antes de
ejecutar nada. No es una tabla con problemas de status — es la ausencia de
un circuito de referencia contra el cual avisar; sin eso no hay nada
informativo que construir, así que no aplica "avisar y seguir".
"""

from __future__ import annotations

import logging
import os
from typing import Any

import sqlglot
from sqlglot import exp

from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import Tool as MCPTool

import auth
import circuits
import db

# El transporte HTTP mantiene el protocolo fuera de stdout.
logging.basicConfig(level=logging.INFO)
registrador = logging.getLogger("popey-mcp.server")

URL_PUBLICA = os.environ.get("MCP_PUBLIC_URL", "http://localhost:8000")

ROL_ADMIN = "admin"

# Tools visibles y ejecutables por cualquier usuario autenticado: trabajan
# sobre el rol del token (circuits_rol). Todo lo demás es solo para admin —
# fail closed: un tool nuevo queda restringido hasta que se lo agregue acá.
HERRAMIENTAS_PARA_CUALQUIER_ROL = frozenset({"get_circuit_rol", "query_circuit_rol"})


def _rol_del_usuario_actual() -> str | None:
    token_acceso = get_access_token()
    return token_acceso.scopes[0] if token_acceso and token_acceso.scopes else None


def _herramienta_permitida(nombre_herramienta: str, rol: str | None) -> bool:
    return rol == ROL_ADMIN or (rol is not None and nombre_herramienta in HERRAMIENTAS_PARA_CUALQUIER_ROL)


class RoleAwareMCPServer(MCPServer):
    """MCPServer que filtra tools/list y tools/call según el rol del token.

    Se engancha en list_tools/call_tool, que son los dos puntos por los que
    pasan todos los requests de tools del SDK. Ocultar en el listado no
    alcanza (un cliente puede llamar a un tool por nombre sin listarlo), por
    eso call_tool valida también.
    """

    async def list_tools(self) -> list[MCPTool]:
        rol = _rol_del_usuario_actual()
        return [
            herramienta
            for herramienta in await super().list_tools()
            if _herramienta_permitida(herramienta.name, rol)
        ]

    async def call_tool(self, name: str, arguments: dict[str, Any], context=None):
        rol = _rol_del_usuario_actual()
        if not _herramienta_permitida(name, rol):
            registrador.warning("tool denegado user_rol=%s tool=%s", rol, name)
            # Mismo mensaje que un tool inexistente: no confirma que el tool exista.
            raise ToolError(f"Unknown tool: {name}")
        try:
            return await super().call_tool(name, arguments, context)
        except UnexpectedToolError as error_inesperado:
            # Desde mcp 2.2 solo el texto de un ToolError llega al modelo; el
            # resto se trata como crash y el mensaje queda en el servidor. Los
            # rechazos de negocio (guarda de SELECT, error de Postgres, circuito
            # o rol inexistente) son feedback que el modelo necesita para
            # corregir la query, así que se reexponen como ToolError.
            # DbConnectionError y cualquier otra cosa siguen como crash.
            causa = error_inesperado.__cause__
            if isinstance(causa, (db.DbGuardRejected, db.DbQueryError, circuits.CircuitNotFoundError)):
                mensaje = causa.args[0] if causa.args else str(causa)
                raise ToolError(f"Error executing tool {name}: {mensaje}") from causa
            raise


# Bearer token obligatorio: los usuarios los da de alta el admin por consola
# (scripts/create_user.py). El SDK exige AuthSettings para activar el
# TokenVerifier; issuer_url queda inerte: sin auth_server_provider no se montan
# rutas OAuth y con resource_server_url=None no se publica metadata OAuth.
servidor_mcp = RoleAwareMCPServer(
    token_verifier=auth.FileTokenVerifier(auth.obtener_ruta_archivo_usuarios()),
    auth=AuthSettings(issuer_url=URL_PUBLICA, resource_server_url=None),
    name="popey-erp",
    description=(
        "Consulta de solo lectura sobre la base de Popey ERP, organizada por "
        "circuitos de negocio (venta, compras, stock, etc.)."
    ),
)


# ---------------------------------------------------------------------------
# Helpers internos — no son tools, los usa query_circuit.
# ---------------------------------------------------------------------------


def _extraer_tablas(consulta_sql: str) -> tuple[list[str], list[str]]:
    """Tablas referenciadas por `consulta_sql`, en formato "schema.tabla", y warnings de parseo.

    Si sqlglot no puede parsear la query, devuelve ([], [warning]) — la
    ejecución sigue igual (ver política de warnings del módulo); el guardián
    real de "es un SELECT válido" es db.ejecutar_select, no esto.

    Si una tabla no trae schema explícito (ej. `FROM entidadcp`), se asume
    "public" (el search_path por defecto de Postgres) y se avisa, porque es
    una suposición, no un hecho confirmado por el SQL.

    Los alias de CTE (`WITH x AS (...) SELECT * FROM x`) se excluyen: sqlglot
    los expone como exp.Table igual que una tabla real, pero no lo son.
    """
    try:
        arbol_sintactico = sqlglot.parse_one(consulta_sql, dialect="postgres")
    except Exception as error_parseo:  # sqlglot.errors.ParseError y variantes internas
        return [], [f"No se pudieron determinar las tablas de la consulta (falló el parseo SQL): {error_parseo}"]

    nombres_cte = {definicion_cte.alias for definicion_cte in arbol_sintactico.find_all(exp.CTE)}

    advertencias: list[str] = []
    tablas_referenciadas: list[str] = []
    tablas_vistas: set[str] = set()
    for nodo_tabla in arbol_sintactico.find_all(exp.Table):
        # Un CTE nunca lleva schema: `otro_schema.x` es una tabla real aunque
        # exista un CTE llamado `x`. Sin este chequeo, el CTE la escondería de
        # la validación de query_circuit_rol.
        if nodo_tabla.name in nombres_cte and not nodo_tabla.db:
            continue
        esquema = nodo_tabla.db or "public"
        if not nodo_tabla.db:
            advertencias.append(
                f"'{nodo_tabla.name}' no especifica schema en la query; se asumió "
                f"'{esquema}.{nodo_tabla.name}' para la validación contra el circuito."
            )
        nombre_completo = f"{esquema}.{nodo_tabla.name}"
        if nombre_completo not in tablas_vistas:
            tablas_vistas.add(nombre_completo)
            tablas_referenciadas.append(nombre_completo)
    return tablas_referenciadas, advertencias


def _obtener_token_obligatorio():
    """Token del request actual; lo usan los tools que dependen del rol del usuario."""
    token_acceso = get_access_token()
    if token_acceso is None or not token_acceso.scopes:
        raise ToolError("El request no trae un usuario autenticado con rol.")
    return token_acceso


def _base_de_datos_del_usuario() -> str:
    """Clave de la base del usuario autenticado (`database` en users.yaml, viaja en claims)."""
    token_acceso = get_access_token()
    if token_acceso is None:
        raise ToolError("El request no trae un usuario autenticado.")
    return (token_acceso.claims or {}).get("database", db.BASE_DE_DATOS_POR_DEFECTO)


def _armar_advertencias_de_tablas(
    nombre_circuito: str, tablas_referenciadas: list[str]
) -> tuple[list[str], list[str]]:
    """Devuelve (tablas_con_advertencia, advertencias) — nunca bloqueante, ver política del módulo."""
    tablas_por_nombre = {tabla.table: tabla for tabla in circuits.obtener_tablas(nombre_circuito)}
    tablas_con_advertencia: list[str] = []
    advertencias: list[str] = []
    for nombre_tabla in tablas_referenciadas:
        datos_tabla = tablas_por_nombre.get(nombre_tabla)
        if datos_tabla is None:
            tablas_con_advertencia.append(nombre_tabla)
            advertencias.append(
                f"'{nombre_tabla}' no está en la lista de tablas del circuito '{nombre_circuito}' "
                "(no bloquea la ejecución, es solo informativo)."
            )
            continue
        tabla_tiene_advertencia = False
        if datos_tabla.needs_review:
            advertencias.append(
                f"'{nombre_tabla}' está marcada needs_review en el circuito '{nombre_circuito}': "
                f"{datos_tabla.notes or datos_tabla.role}"
            )
            tabla_tiene_advertencia = True
        if datos_tabla.is_legacy:
            advertencias.append(
                f"'{nombre_tabla}' es un esquema legacy en el circuito '{nombre_circuito}': "
                f"{datos_tabla.notes or datos_tabla.role}"
            )
            tabla_tiene_advertencia = True
        if tabla_tiene_advertencia:
            tablas_con_advertencia.append(nombre_tabla)
    return tablas_con_advertencia, advertencias


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@servidor_mcp.tool()
def list_circuits() -> list[dict[str, str]]:
    """Lista los circuitos de negocio de Popey disponibles, con su descripción corta."""
    return [
        {"name": nombre_circuito, "description": circuits.obtener_descripcion(nombre_circuito)}
        for nombre_circuito in circuits.listar_circuitos()
    ]


@servidor_mcp.tool()
def get_circuit_rol() -> dict[str, Any]:
    """Tablas visibles para el rol del usuario autenticado, con sus columnas reales de Postgres.

    El rol sale del token del request (FileTokenVerifier lo carga en scopes),
    no de un parámetro: el modelo no puede pedir las tablas de otro rol. Las
    tablas se definen en la sección circuits_rol de circuits.yaml.
    """
    token_acceso = _obtener_token_obligatorio()
    # CircuitNotFoundError si el rol no tiene circuito
    circuito_del_rol = circuits.obtener_circuito_de_rol(token_acceso.scopes[0])
    nombres_tablas = circuito_del_rol.tables
    columnas_reales = (
        db.obtener_columnas_de_tablas(_base_de_datos_del_usuario(), nombres_tablas) if nombres_tablas else {}
    )

    return {
        "user": token_acceso.client_id,
        "rol": circuito_del_rol.rol,
        "description": circuito_del_rol.description,
        "tables": [
            {"table": nombre_tabla, "columns": columnas_reales.get(nombre_tabla, [])}
            for nombre_tabla in nombres_tablas
        ],
    }


@servidor_mcp.tool()
def query_circuit_rol(
    sql: str,
    params: list[Any] | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ejecuta un SELECT de solo lectura contra Popey, restringido a las tablas del rol del usuario.

    Igual que query_circuit, pero el contexto no es un circuito elegido por el
    modelo sino el rol del token (ver get_circuit_rol). A diferencia de
    query_circuit, esto SÍ es una barrera: si `sql` referencia alguna tabla
    que no está en circuits_rol para ese rol, la query se rechaza sin
    ejecutarse. Si no se pueden determinar las tablas (falla el parseo), también
    se rechaza. `params` funciona igual que en query_circuit.

    Devuelve {"rows": [...], "warnings": [...]}. `warnings` puede estar vacío.
    """
    token_acceso = _obtener_token_obligatorio()
    rol = token_acceso.scopes[0]
    tablas_permitidas = set(circuits.obtener_circuito_de_rol(rol).tables)  # CircuitNotFoundError si el rol no tiene circuito

    tablas_referenciadas, advertencias_parseo = _extraer_tablas(sql)
    # Fail closed: sin tablas identificadas no hay forma de probar que la query
    # respeta el rol. Una tabla sin schema se asume "public" en _extraer_tablas,
    # y como circuits_rol lista todo con schema, termina rechazada acá.
    if not tablas_referenciadas:
        raise ToolError(
            "No se pudieron determinar las tablas de la consulta; no se ejecuta. "
            + " ".join(advertencias_parseo)
        )
    tablas_prohibidas = [
        nombre_tabla for nombre_tabla in tablas_referenciadas if nombre_tabla not in tablas_permitidas
    ]

    sql_final = db.armar_sql_final(sql)

    # Auditoría: se loguean también los rechazos, porque acá un intento de leer
    # tablas fuera del rol es justamente lo que interesa registrar.
    registrador.log(
        logging.WARNING if tablas_prohibidas or advertencias_parseo else logging.INFO,
        "query_circuit_rol user=%s rol=%s sql=%r tablas_rechazadas=%s warnings=%s",
        token_acceso.client_id,
        rol,
        sql_final,
        tablas_prohibidas,
        advertencias_parseo,
    )

    if tablas_prohibidas:
        raise ToolError(
            f"El rol '{rol}' no tiene acceso a: {', '.join(tablas_prohibidas)}. "
            "Usá get_circuit_rol para ver las tablas disponibles."
        )

    filas = db.ejecutar_select(_base_de_datos_del_usuario(), sql_final, params, aplicar_limite_por_defecto=False)
    return {"rows": filas, "warnings": advertencias_parseo}


@servidor_mcp.tool()
def query_circuit(
    circuito: str,
    sql: str,
    params: list[Any] | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ejecuta un SELECT de solo lectura contra Popey, en el contexto de un circuito de negocio.

    `circuito` es un nombre de circuito de list_circuits (ej. "venta"). Es
    solo contexto para armar `warnings`: si la query toca tablas fuera del
    circuito, o marcadas needs_review/legacy, se avisa pero la query se
    ejecuta igual — circuito no restringe qué se puede leer. `sql` debe ser
    un único SELECT (`db.py` lo valida y rechaza cualquier otra cosa). `params`
    son los parámetros posicionales (lista, para placeholders `%s`) o
    nombrados (dict, para `%(nombre)s`) de la query, si usa alguno — nunca
    interpolar valores directamente en `sql`.

    Devuelve {"rows": [...], "warnings": [...]}. `warnings` puede estar vacío.
    """
    # ÚNICA excepción bloqueante a la política de warn-and-execute del módulo
    # (ver docstring arriba): un `circuito` que no existe no es una tabla con
    # problemas de status, es la ausencia total de referencia contra la cual
    # avisar — no hay lista de tablas que consultar ni "role/notes" que citar
    # en un warning, así que no hay nada informativo que construir. Se
    # rechaza acá, antes de tocar sqlglot o Postgres.
    if not circuits.existe_circuito(circuito):
        raise ToolError(
            f"No existe el circuito '{circuito}'. Circuitos disponibles: "
            f"{', '.join(circuits.listar_circuitos())}"
        )

    tablas_referenciadas, advertencias_parseo = _extraer_tablas(sql)
    tablas_con_advertencia, advertencias_tablas = (
        _armar_advertencias_de_tablas(circuito, tablas_referenciadas) if tablas_referenciadas else ([], [])
    )
    todas_las_advertencias = [*advertencias_parseo, *advertencias_tablas]

    sql_final = db.armar_sql_final(sql)
    filas = db.ejecutar_select(_base_de_datos_del_usuario(), sql_final, params, aplicar_limite_por_defecto=False)

    # Auditoría: circuito pedido, SQL final ejecutado, y qué tablas generaron
    # warning (si las hubo). WARNING si hubo algo que avisar, INFO si no —
    # así se puede filtrar por nivel sin perder el registro de las queries
    # limpias. No cubre intentos rechazados por la guarda de db.py ni errores
    # de Postgres: esos nunca llegan a este punto (ver limitación abajo).
    # user es el `name` de users.yaml del token que hizo el request; rol viaja
    # en scopes (lo carga FileTokenVerifier).
    token_acceso = get_access_token()
    registrador.log(
        logging.WARNING if todas_las_advertencias else logging.INFO,
        "query_circuit user=%s rol=%s circuito=%s sql=%r tablas_con_warning=%s warnings=%s",
        token_acceso.client_id if token_acceso else None,
        ",".join(token_acceso.scopes) if token_acceso else None,
        circuito,
        sql_final,
        tablas_con_advertencia,
        todas_las_advertencias,
    )

    return {"rows": filas, "warnings": todas_las_advertencias}


@servidor_mcp.tool()
def get_circuit_schema(circuito: str) -> dict[str, Any]:
    """Esquema completo de un circuito: metadata de negocio + columnas reales de Postgres.

    Pensado para que el modelo sepa qué tablas/columnas puede usar antes de
    escribir el `sql` de query_circuit. Junta circuits.obtener_tablas(circuito)
    (role/key_columns/source/status/notes, la intención de negocio) con
    db.obtener_columnas_de_tablas(...) (columnas reales tal como están hoy en la base).
    Si una tabla listada en circuits.yaml no existe en la base (o no se pudo
    introspeccionar), su `columns` viene vacío — no es un error.
    """
    datos_circuito = circuits.obtener_circuito(circuito)  # CircuitNotFoundError con mensaje claro si no existe

    nombres_tablas = datos_circuito.table_names()
    columnas_reales = (
        db.obtener_columnas_de_tablas(_base_de_datos_del_usuario(), nombres_tablas) if nombres_tablas else {}
    )

    tablas = [
        {
            "table": tabla.table,
            "role": tabla.role,
            "key_columns": list(tabla.key_columns),
            "source": tabla.source,
            "status": list(tabla.status),
            "notes": tabla.notes,
            "columns": columnas_reales.get(tabla.table, []),
        }
        for tabla in datos_circuito.tables
    ]

    columnas_pendientes = [
        {
            "table": columna_pendiente.table,
            "column": columna_pendiente.column,
            "status": columna_pendiente.status,
            "description": columna_pendiente.description,
            "source": columna_pendiente.source,
        }
        for columna_pendiente in datos_circuito.pending_columns
    ]

    return {
        "circuito": datos_circuito.name,
        "description": datos_circuito.description,
        "naming_note": datos_circuito.naming_note,
        "docs": list(datos_circuito.docs),
        "tables": tablas,
        "pending_columns": columnas_pendientes,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def iniciar_servidor() -> None:
    # Sin pool global al arrancar: db.obtener_pool crea el pool de cada base en el
    # primer request de un usuario que apunta a ella.
    try:
        hosts_permitidos = [
            nombre_host.strip()
            for nombre_host in os.environ.get(
                "MCP_ALLOWED_HOSTS", "localhost:8000,127.0.0.1:8000"
            ).split(",")
            if nombre_host.strip()
        ]
        servidor_mcp.run(
            transport="streamable-http",
            host=os.environ.get("MCP_HOST", "0.0.0.0"),
            port=int(os.environ.get("MCP_PORT", "8000")),
            transport_security=TransportSecuritySettings(allowed_hosts=hosts_permitidos),
        )
    finally:
        db.cerrar_todos_los_pools()


if __name__ == "__main__":
    iniciar_servidor()
