"""db.py — acceso a PostgreSQL para el resto del código (sobre todo server.py).

Mismo criterio que circuits.py: acá vive el detalle de cómo se habla con la
base (pool de conexiones, psycopg2, SQL crudo). El resto del código no debería
importar psycopg2 ni saber que hay un pool — solo llama a las funciones
públicas de este módulo.

El modo solo lectura lo impone Postgres, no el rol: cada query corre dentro
de una transacción `READ ONLY` (psycopg2 `set_session(readonly=True)` →
`BEGIN READ ONLY`) que siempre termina en ROLLBACK, y además cada conexión
física del pool arranca con `default_transaction_read_only=on`. Postgres
rechaza cualquier escritura dentro de esa transacción (tablas, secuencias,
DDL, e incluso funciones plpgsql con efectos secundarios), así que el MCP
puede conectarse con un rol que tenga permisos de escritura.

Las guardas de acá (_validar_solo_select, límite de filas, timeout) son una
SEGUNDA capa de defensa en profundidad, no la única, y están escritas para
ser simples y explicables, no para parsear SQL completo. Bloquean en
particular `SET`/`RESET`/`set_config`, que es la única forma de apagar el
modo read-only desde una query.

Historial: hasta 2026-09-23 la barrera primaria era un rol read-only
dedicado (`mcp_popey_ro`, ver `scripts/create_readonly_role.sql`) y
el arranque abortaba si el rol conectado tenía permisos de escritura. Se
reemplazó por la transacción read-only para no depender del rol. Usar
`mcp_popey_ro` sigue siendo la opción más segura cuando esté disponible.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from dotenv import load_dotenv
load_dotenv()

import psycopg2
import psycopg2.extras
import psycopg2.pool

registrador = logging.getLogger("popey-mcp.db")

# ---------------------------------------------------------------------------
# Errores — server.py atrapa estos tipos, nunca psycopg2.Error crudo.
# ---------------------------------------------------------------------------


class DbError(Exception):
    """Base de todos los errores que este módulo deja escapar."""


class DbGuardRejected(DbError):
    """La query no pasó las guardas de código (no es un SELECT simple de solo lectura)."""


class DbConnectionError(DbError):
    """No se pudo obtener/devolver una conexión del pool."""


class DbQueryError(DbError):
    """Postgres devolvió un error al ejecutar la query (mensaje limpio, sin traceback crudo)."""

    def __init__(self, message: str, *, sqlstate: str | None = None):
        super().__init__(message)
        self.sqlstate = sqlstate


# ---------------------------------------------------------------------------
# Configuración — variables de entorno, leídas explícitamente (no se confía
# en que psycopg2 las lea solo, aunque podría).
#
# Cada usuario del MCP apunta a una base por clave (`database` en users.yaml).
# La clave "default" usa PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD; cualquier
# otra clave `<k>` se configura con `DB_<K>_DSN` (conninfo de libpq o URL
# postgresql://...). Si no hay configuración para la clave, se rechaza: un
# usuario nunca cae por defecto en otra base.
# ---------------------------------------------------------------------------

BASE_DE_DATOS_POR_DEFECTO = "default"
_PATRON_CLAVE_BASE_DATOS = re.compile(r"^[a-z0-9_]{1,32}$")


@dataclass(frozen=True)
class DbConfig:
    dsn: str | None
    host: str
    port: int
    dbname: str
    user: str
    password: str
    pool_min: int
    pool_max: int
    statement_timeout_ms: int

    @classmethod
    def from_env(cls, database: str = BASE_DE_DATOS_POR_DEFECTO) -> "DbConfig":
        if not _PATRON_CLAVE_BASE_DATOS.match(database):
            raise DbConnectionError(f"Clave de base de datos inválida: {database!r}.")
        opciones_comunes = dict(
            pool_min=int(os.environ.get("DB_POOL_MIN", "1")),
            pool_max=int(os.environ.get("DB_POOL_MAX", "5")),
            statement_timeout_ms=int(os.environ.get("DB_STATEMENT_TIMEOUT_MS", "30000")),
        )
        dsn_configurado = os.environ.get(f"DB_{database.upper()}_DSN")
        if dsn_configurado:
            return cls(
                dsn=dsn_configurado, host="", port=0, dbname="", user="", password="", **opciones_comunes
            )
        if database != BASE_DE_DATOS_POR_DEFECTO:
            raise DbConnectionError(
                f"Base de datos no autorizada: {database!r} (falta DB_{database.upper()}_DSN)."
            )
        variables_faltantes = [
            nombre_variable
            for nombre_variable in ("PGDATABASE", "PGUSER", "PGPASSWORD")
            if not os.environ.get(nombre_variable)
        ]
        if variables_faltantes:
            raise DbConnectionError(
                "Faltan variables de entorno obligatorias para conectar a Postgres: "
                + ", ".join(variables_faltantes)
            )
        return cls(
            dsn=None,
            host=os.environ.get("PGHOST", "localhost"),
            port=int(os.environ.get("PGPORT", "5432")),
            dbname=os.environ["PGDATABASE"],
            user=os.environ["PGUSER"],
            password=os.environ["PGPASSWORD"],
            **opciones_comunes,
        )

    def connect_kwargs(self) -> dict[str, Any]:
        if self.dsn:
            return {"dsn": self.dsn}
        return {
            "host": self.host,
            "port": self.port,
            "dbname": self.dbname,
            "user": self.user,
            "password": self.password,
        }


def _limite_filas_por_defecto() -> int:
    return int(os.environ.get("DB_DEFAULT_ROW_LIMIT", "1000"))


# ---------------------------------------------------------------------------
# Pools — uno por clave de base, creado lazy en el primer request de un
# usuario de esa base (usuarios de la misma base comparten pool). Threaded
# (no Simple): las tools sync del SDK corren en threads del executor. El lock
# evita que dos requests concurrentes creen dos pools para la misma clave.
# ---------------------------------------------------------------------------

_pools_por_base: dict[str, psycopg2.pool.ThreadedConnectionPool] = {}
_candado_pools = threading.Lock()

_OPCIONES_SOLO_LECTURA = "-c default_transaction_read_only=on"


def _verificar_sesion_solo_lectura(conexion) -> None:
    """Verifica que una transacción de esta conexión quede efectivamente en READ ONLY.

    Si por algún motivo (versión de psycopg2, configuración del servidor) la
    transacción no quedara en modo lectura, el pool no se crea: esa es la
    barrera primaria contra escrituras.
    """
    conexion.set_session(readonly=True, autocommit=False)
    try:
        with conexion.cursor() as cursor:
            cursor.execute("SHOW transaction_read_only")
            (valor_solo_lectura,) = cursor.fetchone()
    finally:
        conexion.rollback()
    if valor_solo_lectura != "on":
        raise DbConnectionError(
            f"La transacción no quedó en modo READ ONLY (transaction_read_only={valor_solo_lectura!r})."
        )


def _crear_pool(configuracion: DbConfig) -> psycopg2.pool.ThreadedConnectionPool:
    """Crea un pool y verifica el modo READ ONLY; si falla, lo cierra y levanta DbConnectionError."""
    try:
        pool_conexiones = psycopg2.pool.ThreadedConnectionPool(
            configuracion.pool_min,
            configuracion.pool_max,
            # statement_timeout y read-only por defecto aplicados a nivel de sesión
            # de cada conexión física del pool, una sola vez al crearse.
            options=f"-c statement_timeout={configuracion.statement_timeout_ms} {_OPCIONES_SOLO_LECTURA}",
            **configuracion.connect_kwargs(),
        )
    except psycopg2.Error as error:
        raise DbConnectionError(f"No se pudo inicializar el pool de conexiones: {error}") from error

    conexion = pool_conexiones.getconn()
    try:
        _verificar_sesion_solo_lectura(conexion)
    except (DbConnectionError, psycopg2.Error) as error:
        pool_conexiones.putconn(conexion)
        pool_conexiones.closeall()
        if isinstance(error, DbConnectionError):
            raise
        raise DbConnectionError(f"No se pudo verificar el modo read-only: {error}") from error
    pool_conexiones.putconn(conexion)
    return pool_conexiones


def obtener_pool(clave_base_datos: str) -> psycopg2.pool.ThreadedConnectionPool:
    """Pool de la base `clave_base_datos`, creándolo en el primer uso."""
    pool_conexiones = _pools_por_base.get(clave_base_datos)
    if pool_conexiones is not None:
        return pool_conexiones
    with _candado_pools:
        pool_conexiones = _pools_por_base.get(clave_base_datos)
        if pool_conexiones is None:
            pool_conexiones = _crear_pool(DbConfig.from_env(clave_base_datos))
            _pools_por_base[clave_base_datos] = pool_conexiones
            registrador.info("pool creado para la base %r", clave_base_datos)
    return pool_conexiones


def cerrar_todos_los_pools() -> None:
    """Cierra todas las conexiones de todos los pools. Lo llama server.py al apagarse."""
    with _candado_pools:
        for pool_conexiones in _pools_por_base.values():
            pool_conexiones.closeall()
        _pools_por_base.clear()


@contextmanager
def obtener_conexion(clave_base_datos: str):
    """Conexión del pool de `clave_base_datos`, devuelta siempre, sin dejar transacciones colgadas.

    Cada uso abre una transacción READ ONLY y la cierra con ROLLBACK: aunque
    algo escapara a las guardas, nunca se hace COMMIT.
    """
    pool_conexiones = obtener_pool(clave_base_datos)
    try:
        conexion = pool_conexiones.getconn()
    except psycopg2.pool.PoolError as error:
        raise DbConnectionError(f"No se pudo obtener una conexión del pool: {error}") from error
    try:
        conexion.set_session(readonly=True, autocommit=False)
        yield conexion
    finally:
        try:
            conexion.rollback()
        finally:
            pool_conexiones.putconn(conexion)


# ---------------------------------------------------------------------------
# Guardas de código — segunda capa, ver docstring del módulo.
# ---------------------------------------------------------------------------

_PATRON_COMENTARIOS = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)

# Palabras que no deberían aparecer en un SELECT de solo lectura legítimo.
# No es una lista exhaustiva ni un parser de SQL — es defensa en profundidad
# sobre la transacción READ ONLY. SET/RESET se bloquean porque son la vía
# para apagar el modo read-only; INTO porque `SELECT ... INTO` crea tablas.
_PALABRAS_PROHIBIDAS = (
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "GRANT",
    "REVOKE", "CREATE", "EXECUTE", "CALL", "COPY", "VACUUM", "REINDEX",
    "MERGE", "LOCK",
    "PG_SLEEP", "PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND",
    "PG_READ_FILE", "PG_READ_BINARY_FILE", "PG_LS_DIR", "LO_IMPORT", "LO_EXPORT",
    "DBLINK", "SET_CONFIG", "SET", "RESET", "INTO",
)
_PATRON_PALABRAS_PROHIBIDAS = re.compile(
    r"\b(" + "|".join(_PALABRAS_PROHIBIDAS) + r")\b", re.IGNORECASE
)
_PATRON_LIMIT = re.compile(r"\bLIMIT\b", re.IGNORECASE)


def _quitar_comentarios(consulta_sql: str) -> str:
    return _PATRON_COMENTARIOS.sub(" ", consulta_sql)


def _validar_solo_select(consulta_sql: str) -> None:
    """Rechaza cualquier cosa que no sea un único SELECT de solo lectura simple.

    Deliberadamente estricto y simple, NO soporta CTEs (WITH ...): un WITH
    puede esconder un DELETE/INSERT en una de sus subconsultas
    (`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`), y distinguir
    ese caso de un CTE inocente requiere parsear SQL de verdad. Si hace falta
    soportar CTEs de lectura, es un cambio a propósito más adelante, no un
    relajamiento silencioso de esta guarda.
    """
    if not consulta_sql or not consulta_sql.strip():
        raise DbGuardRejected("La query está vacía.")

    consulta_sin_comentarios = _quitar_comentarios(consulta_sql).strip()

    # Un solo ; final se tolera (y se descarta); cualquier ; interno indica
    # múltiples sentencias (ej. "SELECT 1; DROP TABLE x;") y se rechaza.
    cuerpo_consulta = (
        consulta_sin_comentarios[:-1].strip()
        if consulta_sin_comentarios.endswith(";")
        else consulta_sin_comentarios
    )
    if ";" in cuerpo_consulta:
        raise DbGuardRejected(
            "Solo se permite una única sentencia por consulta (se encontró ';' antes del final)."
        )

    if not re.match(r"^SELECT\b", cuerpo_consulta, re.IGNORECASE):
        raise DbGuardRejected("Solo se permiten consultas que empiecen con SELECT.")

    coincidencia_prohibida = _PATRON_PALABRAS_PROHIBIDAS.search(cuerpo_consulta)
    if coincidencia_prohibida:
        raise DbGuardRejected(
            f"La consulta contiene una palabra no permitida en una lectura de solo datos: {coincidencia_prohibida.group(1)!r}."
        )


def _asegurar_limit(consulta_sql: str, limite_por_defecto: int) -> str:
    """Agrega `LIMIT <limite_por_defecto>` si la query no tiene ninguno.

    Limitación conocida y aceptada: es un chequeo por substring, no por
    estructura de la query. Un LIMIT que solo aparece dentro de una subquery
    (ej. `SELECT * FROM (SELECT x FROM y LIMIT 5) z`) hace que esta función
    NO agregue un LIMIT exterior, aunque el SELECT de más afuera sí pueda
    devolver todas las filas de z sin tope. Aceptado como parte del "chequeo
    simple pero efectivo" pedido — no es una garantía dura de tope de filas.
    """
    cuerpo_consulta = consulta_sql.strip()
    if cuerpo_consulta.endswith(";"):
        cuerpo_consulta = cuerpo_consulta[:-1].strip()
    if _PATRON_LIMIT.search(_quitar_comentarios(cuerpo_consulta)):
        return cuerpo_consulta
    return f"{cuerpo_consulta} LIMIT {limite_por_defecto}"


# ---------------------------------------------------------------------------
# API pública
# ---------------------------------------------------------------------------


def armar_sql_final(consulta_sql: str, *, aplicar_limite_por_defecto: bool = True) -> str:
    """Devuelve el SQL tal como lo va a correr `ejecutar_select`, sin ejecutarlo.

    Pensada para que quien llama (server.py) pueda loguear/mostrar exactamente
    qué se va a ejecutar ANTES de ejecutarlo — no valida nada (no reemplaza a
    `_validar_solo_select`, que corre dentro de `ejecutar_select`).
    """
    if not aplicar_limite_por_defecto:
        cuerpo_consulta = consulta_sql.strip()
        return cuerpo_consulta[:-1].strip() if cuerpo_consulta.endswith(";") else cuerpo_consulta
    return _asegurar_limit(consulta_sql, _limite_filas_por_defecto())


def ejecutar_select(
    clave_base_datos: str,
    consulta_sql: str,
    parametros: Sequence[Any] | Mapping[str, Any] | None = None,
    *,
    aplicar_limite_por_defecto: bool = True,
) -> list[dict]:
    """Ejecuta un SELECT de solo lectura en la base `clave_base_datos` y devuelve las filas como lista de dicts.

    Aplica las guardas de código antes de ejecutar (`_validar_solo_select`)
    y agrega un LIMIT por defecto si la query no trae uno (salvo que se pase
    `aplicar_limite_por_defecto=False`, ver `armar_sql_final`). Nunca deja escapar
    `psycopg2.Error` crudo: lo envuelve en `DbQueryError` con un mensaje
    limpio. Errores de guarda levantan `DbGuardRejected` (subclase de
    DbError, igual que DbQueryError, así server.py puede atrapar `DbError`
    en general o distinguir el motivo).
    """
    _validar_solo_select(consulta_sql)
    sql_final = armar_sql_final(consulta_sql, aplicar_limite_por_defecto=aplicar_limite_por_defecto)

    with obtener_conexion(clave_base_datos) as conexion:
        try:
            with conexion.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute(sql_final, parametros)
                filas = cursor.fetchall()
                return [dict(fila) for fila in filas]
        except psycopg2.Error as error:
            codigo_sqlstate = getattr(error, "pgcode", None)
            mensaje_error = getattr(getattr(error, "diag", None), "message_primary", None) or str(error).strip()
            raise DbQueryError(mensaje_error, sqlstate=codigo_sqlstate) from error


def obtener_columnas_de_tablas(clave_base_datos: str, nombres_tablas: Sequence[str]) -> dict[str, list[dict]]:
    """Consulta information_schema.columns de la base `clave_base_datos`, acotado a las tablas pasadas.

    `nombres_tablas` va en formato "schema.tabla" (el mismo formato que usa
    circuits.py). Nunca arma un SELECT * sin filtro: siempre consulta con
    `WHERE (table_schema, table_name) IN (...)` parametrizado.

    Devuelve {"schema.tabla": [{"column_name", "data_type", "is_nullable",
    "column_default", "ordinal_position"}, ...]}, ordenado por
    ordinal_position. Las tablas pasadas que no existen en la base
    simplemente no aparecen en el resultado (no es un error).
    """
    pares_esquema_tabla: list[tuple[str, str]] = []
    for nombre_completo in nombres_tablas:
        partes = nombre_completo.split(".")
        if len(partes) != 2:
            raise DbGuardRejected(
                f"'{nombre_completo}' no tiene el formato esperado 'schema.tabla'."
            )
        pares_esquema_tabla.append((partes[0], partes[1]))

    if not pares_esquema_tabla:
        return {}

    clausula_values = ", ".join(["(%s, %s)"] * len(pares_esquema_tabla))
    parametros_planos: list[str] = [valor for par in pares_esquema_tabla for valor in par]

    consulta_sql = f"""
        SELECT table_schema, table_name, column_name, data_type,
               is_nullable, column_default, ordinal_position
        FROM information_schema.columns
        WHERE (table_schema, table_name) IN ({clausula_values})
        ORDER BY table_schema, table_name, ordinal_position
    """

    with obtener_conexion(clave_base_datos) as conexion:
        try:
            with conexion.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute(consulta_sql, parametros_planos)
                filas = cursor.fetchall()
        except psycopg2.Error as error:
            codigo_sqlstate = getattr(error, "pgcode", None)
            mensaje_error = getattr(getattr(error, "diag", None), "message_primary", None) or str(error).strip()
            raise DbQueryError(mensaje_error, sqlstate=codigo_sqlstate) from error

    columnas_por_tabla: dict[str, list[dict]] = {}
    for fila in filas:
        nombre_tabla = f"{fila['table_schema']}.{fila['table_name']}"
        columnas_por_tabla.setdefault(nombre_tabla, []).append(
            {
                "column_name": fila["column_name"],
                "data_type": fila["data_type"],
                "is_nullable": fila["is_nullable"],
                "column_default": fila["column_default"],
                "ordinal_position": fila["ordinal_position"],
            }
        )
    return columnas_por_tabla


def verificar_conexion(clave_base_datos: str = BASE_DE_DATOS_POR_DEFECTO) -> bool:
    """True si se pudo conectar a `clave_base_datos` y correr `SELECT 1`. No lanza excepción propia: devuelve False."""
    try:
        filas = ejecutar_select(clave_base_datos, "SELECT 1 AS ok", aplicar_limite_por_defecto=False)
        return filas == [{"ok": 1}]
    except DbError:
        return False


if __name__ == "__main__":
    # Chequeo manual rápido: `python db.py [clave]` (default: PGHOST/PGDATABASE/PGUSER/PGPASSWORD).
    import sys

    clave_base_datos = sys.argv[1] if len(sys.argv) > 1 else BASE_DE_DATOS_POR_DEFECTO
    try:
        DbConfig.from_env(clave_base_datos)
    except DbError as error:
        print(f"No configurado: {error}")
    else:
        print(f"Conectando a la base {clave_base_datos!r} ...")
        print("verificar_conexion():", verificar_conexion(clave_base_datos))
        cerrar_todos_los_pools()
