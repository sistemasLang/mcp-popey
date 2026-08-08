"""db.py — acceso a PostgreSQL para el resto del código (sobre todo server.py).

Mismo criterio que circuits.py: acá vive el detalle de cómo se habla con la
base (pool de conexiones, psycopg2, SQL crudo). El resto del código no debería
importar psycopg2 ni saber que hay un pool — solo llama a las funciones
públicas de este módulo.

Este módulo asume que la conexión ya usa un usuario de PostgreSQL read-only
a nivel de rol (GRANT SELECT únicamente) — esa es la barrera real. Las
guardas de acá (_validate_select_only, límite de filas, timeout) son una
SEGUNDA capa de defensa en profundidad, no la única, y están escritas para
ser simples y explicables, no para parsear SQL completo.

`init_pool()` NO confía ciegamente en esa suposición: verifica el permiso
real del rol conectado contra Postgres (ver `_check_read_only_role`) y, si
detecta cualquier permiso de escritura/DDL, aborta el arranque — decisión
explícita: si la barrera "primaria" está comprometida, la guarda de código
de acá pasa a ser la única protección real, y eso no debe pasar en silencio.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import psycopg2
import psycopg2.extras
import psycopg2.pool

logger = logging.getLogger("popey-mcp.db")

# ---------------------------------------------------------------------------
# Errores — server.py atrapa estos tipos, nunca psycopg2.Error crudo.
# ---------------------------------------------------------------------------


class DbError(Exception):
    """Base de todos los errores que este módulo deja escapar."""


class DbGuardRejected(DbError):
    """La query no pasó las guardas de código (no es un SELECT simple de solo lectura)."""


class DbConnectionError(DbError):
    """No se pudo obtener/devolver una conexión del pool."""


class DbWritableRoleError(DbConnectionError):
    """El rol de Postgres conectado tiene algún permiso de escritura/DDL — se esperaba read-only."""


class DbQueryError(DbError):
    """Postgres devolvió un error al ejecutar la query (mensaje limpio, sin traceback crudo)."""

    def __init__(self, message: str, *, sqlstate: str | None = None):
        super().__init__(message)
        self.sqlstate = sqlstate


# ---------------------------------------------------------------------------
# Configuración — variables de entorno, leídas explícitamente (no se confía
# en que psycopg2 las lea solo, aunque podría).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DbConfig:
    host: str
    port: int
    dbname: str
    user: str
    password: str
    pool_min: int
    pool_max: int
    statement_timeout_ms: int
    default_row_limit: int

    @classmethod
    def from_env(cls) -> "DbConfig":
        missing = [
            name
            for name in ("PGDATABASE", "PGUSER", "PGPASSWORD")
            if not os.environ.get(name)
        ]
        if missing:
            raise DbConnectionError(
                "Faltan variables de entorno obligatorias para conectar a Postgres: "
                + ", ".join(missing)
            )
        return cls(
            host=os.environ.get("PGHOST", "localhost"),
            port=int(os.environ.get("PGPORT", "5432")),
            dbname=os.environ["PGDATABASE"],
            user=os.environ["PGUSER"],
            password=os.environ["PGPASSWORD"],
            pool_min=int(os.environ.get("DB_POOL_MIN", "1")),
            pool_max=int(os.environ.get("DB_POOL_MAX", "5")),
            statement_timeout_ms=int(os.environ.get("DB_STATEMENT_TIMEOUT_MS", "30000")),
            default_row_limit=int(os.environ.get("DB_DEFAULT_ROW_LIMIT", "1000")),
        )


# ---------------------------------------------------------------------------
# Pool — Threaded (no Simple) aunque hoy server.py pueda ser de un solo hilo:
# si termina corriendo sobre un framework async, las llamadas a psycopg2
# (bloqueante) se van a despachar típicamente vía threads (asyncio.to_thread
# o un executor), y ahí SimpleConnectionPool no es seguro. Threaded no cuesta
# nada extra en el caso de un solo hilo.
# ---------------------------------------------------------------------------

_pool: psycopg2.pool.ThreadedConnectionPool | None = None
_pool_config: DbConfig | None = None

# Privilegios que consideramos "escritura" para el chequeo de rol read-only.
_WRITE_PRIVILEGES = ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")

_ROLE_CHECK_SQL = """
    SELECT
        r.rolsuper AS is_superuser,
        EXISTS (
            SELECT 1 FROM information_schema.role_table_grants g
            WHERE (g.grantee = current_user OR g.grantee = 'PUBLIC')
              AND g.privilege_type = ANY(%(write_privileges)s)
        ) AS has_write_grant,
        EXISTS (
            SELECT 1 FROM pg_tables t WHERE t.tableowner = current_user
        ) AS owns_tables,
        EXISTS (
            SELECT 1 FROM pg_namespace n
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND has_schema_privilege(current_user, n.nspname, 'CREATE')
        ) AS has_create_privilege
    FROM pg_roles r
    WHERE r.rolname = current_user
"""


def _check_read_only_role(conn) -> dict[str, bool]:
    """Verifica si el rol conectado tiene algún permiso de escritura o DDL.

    Cubre los casos comunes: superusuario (bypassa cualquier GRANT), GRANT
    explícito de INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER (a él o a
    PUBLIC), ser dueño de alguna tabla (los dueños tienen privilegios
    implícitos sin necesidad de GRANT), o tener CREATE sobre algún schema
    no-catálogo (capacidad de DDL). No es una garantía exhaustiva de todos
    los mecanismos de permisos de Postgres (RLS, roles anidados con NOINHERIT,
    etc.), pero cubre las formas usuales en que un rol termina siendo
    escribible sin que se haya hecho explícito.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(_ROLE_CHECK_SQL, {"write_privileges": list(_WRITE_PRIVILEGES)})
        row = cur.fetchone()
    return dict(row) if row else {}


def init_pool(config: DbConfig | None = None) -> None:
    """Crea el pool de conexiones y verifica que el rol conectado sea read-only.

    Lo llama server.py al arrancar (o se crea solo, lazy, en el primer uso).
    Si el rol tiene cualquier permiso de escritura/DDL, loguea CRITICAL y
    ABORTA (cierra el pool recién creado y levanta DbWritableRoleError) —
    decisión explícita, ver docstring del módulo: no arrancar con la barrera
    "primaria" (rol read-only) comprometida.
    """
    global _pool, _pool_config
    config = config or DbConfig.from_env()
    if _pool is not None:
        if _pool_config == config:
            return  # ya inicializado con la misma config, no-op
        close_pool()
    try:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            config.pool_min,
            config.pool_max,
            host=config.host,
            port=config.port,
            dbname=config.dbname,
            user=config.user,
            password=config.password,
            # statement_timeout aplicado a nivel de sesión de cada conexión física
            # del pool, una sola vez al crearse (no en cada query).
            options=f"-c statement_timeout={config.statement_timeout_ms}",
        )
    except psycopg2.Error as exc:
        raise DbConnectionError(f"No se pudo inicializar el pool de conexiones: {exc}") from exc

    conn = _pool.getconn()
    try:
        perms = _check_read_only_role(conn)
    finally:
        _pool.putconn(conn)

    write_flags = {k: v for k, v in perms.items() if v}
    if write_flags:
        logger.critical(
            "El rol de Postgres conectado (%s) tiene permisos de escritura/DDL: %s. "
            "Se esperaba un rol read-only (GRANT SELECT únicamente). Abortando arranque.",
            config.user,
            sorted(write_flags),
        )
        _pool.closeall()
        _pool = None
        raise DbWritableRoleError(
            f"El rol '{config.user}' tiene permisos de escritura/DDL ({sorted(write_flags)}); "
            "se esperaba un rol read-only. Ver logs (CRITICAL) para el detalle."
        )

    _pool_config = config


def close_pool() -> None:
    """Cierra todas las conexiones del pool. Lo llama server.py al apagarse."""
    global _pool, _pool_config
    if _pool is not None:
        _pool.closeall()
    _pool = None
    _pool_config = None


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    if _pool is None:
        init_pool()
    assert _pool is not None
    return _pool


class _PooledConnection:
    """Context manager chico: pide una conexión, la devuelve siempre, sin dejar transacciones colgadas."""

    def __enter__(self):
        pool = _get_pool()
        try:
            self._conn = pool.getconn()
        except psycopg2.pool.PoolError as exc:
            raise DbConnectionError(f"No se pudo obtener una conexión del pool: {exc}") from exc
        self._conn.autocommit = True  # solo SELECTs: sin autocommit quedarían transacciones idle abiertas
        return self._conn

    def __exit__(self, exc_type, exc, tb):
        pool = _get_pool()
        pool.putconn(self._conn)
        return False


# ---------------------------------------------------------------------------
# Guardas de código — segunda capa, ver docstring del módulo.
# ---------------------------------------------------------------------------

_COMMENT_RE = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)

# Palabras que no deberían aparecer en un SELECT de solo lectura legítimo.
# No es una lista exhaustiva ni un parser de SQL — es defensa en profundidad
# sobre el usuario read-only real de Postgres.
_FORBIDDEN_KEYWORDS = (
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "GRANT",
    "REVOKE", "CREATE", "EXECUTE", "CALL", "COPY", "VACUUM", "REINDEX",
    "MERGE", "LOCK",
    "PG_SLEEP", "PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND",
    "PG_READ_FILE", "PG_READ_BINARY_FILE", "PG_LS_DIR", "LO_IMPORT", "LO_EXPORT",
    "DBLINK", "SET_CONFIG",
)
_FORBIDDEN_RE = re.compile(
    r"\b(" + "|".join(_FORBIDDEN_KEYWORDS) + r")\b", re.IGNORECASE
)
_LIMIT_RE = re.compile(r"\bLIMIT\b", re.IGNORECASE)


def _strip_comments(sql: str) -> str:
    return _COMMENT_RE.sub(" ", sql)


def _validate_select_only(sql: str) -> None:
    """Rechaza cualquier cosa que no sea un único SELECT de solo lectura simple.

    Deliberadamente estricto y simple, NO soporta CTEs (WITH ...): un WITH
    puede esconder un DELETE/INSERT en una de sus subconsultas
    (`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`), y distinguir
    ese caso de un CTE inocente requiere parsear SQL de verdad. Si hace falta
    soportar CTEs de lectura, es un cambio a propósito más adelante, no un
    relajamiento silencioso de esta guarda.
    """
    if not sql or not sql.strip():
        raise DbGuardRejected("La query está vacía.")

    stripped = _strip_comments(sql).strip()

    # Un solo ; final se tolera (y se descarta); cualquier ; interno indica
    # múltiples sentencias (ej. "SELECT 1; DROP TABLE x;") y se rechaza.
    body = stripped[:-1].strip() if stripped.endswith(";") else stripped
    if ";" in body:
        raise DbGuardRejected(
            "Solo se permite una única sentencia por consulta (se encontró ';' antes del final)."
        )

    if not re.match(r"^SELECT\b", body, re.IGNORECASE):
        raise DbGuardRejected("Solo se permiten consultas que empiecen con SELECT.")

    forbidden = _FORBIDDEN_RE.search(body)
    if forbidden:
        raise DbGuardRejected(
            f"La consulta contiene una palabra no permitida en una lectura de solo datos: {forbidden.group(1)!r}."
        )


def _ensure_limit(sql: str, default_limit: int) -> str:
    """Agrega `LIMIT <default_limit>` si la query no tiene ninguno.

    Limitación conocida y aceptada: es un chequeo por substring, no por
    estructura de la query. Un LIMIT que solo aparece dentro de una subquery
    (ej. `SELECT * FROM (SELECT x FROM y LIMIT 5) z`) hace que esta función
    NO agregue un LIMIT exterior, aunque el SELECT de más afuera sí pueda
    devolver todas las filas de z sin tope. Aceptado como parte del "chequeo
    simple pero efectivo" pedido — no es una garantía dura de tope de filas.
    """
    body = sql.strip()
    if body.endswith(";"):
        body = body[:-1].strip()
    if _LIMIT_RE.search(_strip_comments(body)):
        return body
    return f"{body} LIMIT {default_limit}"


# ---------------------------------------------------------------------------
# API pública
# ---------------------------------------------------------------------------


def build_final_sql(sql: str, *, apply_default_limit: bool = True) -> str:
    """Devuelve el SQL tal como lo va a correr `execute_select`, sin ejecutarlo.

    Pensada para que quien llama (server.py) pueda loguear/mostrar exactamente
    qué se va a ejecutar ANTES de ejecutarlo — no valida nada (no reemplaza a
    `_validate_select_only`, que corre dentro de `execute_select`).
    """
    if not apply_default_limit:
        body = sql.strip()
        return body[:-1].strip() if body.endswith(";") else body
    config = _pool_config or DbConfig.from_env()
    return _ensure_limit(sql, config.default_row_limit)


def execute_select(
    sql: str,
    params: Sequence[Any] | Mapping[str, Any] | None = None,
    *,
    apply_default_limit: bool = True,
) -> list[dict]:
    """Ejecuta un SELECT de solo lectura y devuelve las filas como lista de dicts.

    Aplica las guardas de código antes de ejecutar (`_validate_select_only`)
    y agrega un LIMIT por defecto si la query no trae uno (salvo que se pase
    `apply_default_limit=False`, ver `build_final_sql`). Nunca deja escapar
    `psycopg2.Error` crudo: lo envuelve en `DbQueryError` con un mensaje
    limpio. Errores de guarda levantan `DbGuardRejected` (subclase de
    DbError, igual que DbQueryError, así server.py puede atrapar `DbError`
    en general o distinguir el motivo).
    """
    _validate_select_only(sql)
    final_sql = build_final_sql(sql, apply_default_limit=apply_default_limit)

    with _PooledConnection() as conn:
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(final_sql, params)
                rows = cur.fetchall()
                return [dict(row) for row in rows]
        except psycopg2.Error as exc:
            sqlstate = getattr(exc, "pgcode", None)
            message = getattr(getattr(exc, "diag", None), "message_primary", None) or str(exc).strip()
            raise DbQueryError(message, sqlstate=sqlstate) from exc


def get_schema_info(table_names: Sequence[str]) -> dict[str, list[dict]]:
    """Consulta information_schema.columns, acotado a las tablas pasadas.

    `table_names` va en formato "schema.tabla" (el mismo formato que usa
    circuits.py). Nunca arma un SELECT * sin filtro: siempre consulta con
    `WHERE (table_schema, table_name) IN (...)` parametrizado.

    Devuelve {"schema.tabla": [{"column_name", "data_type", "is_nullable",
    "column_default", "ordinal_position"}, ...]}, ordenado por
    ordinal_position. Las tablas pasadas que no existen en la base
    simplemente no aparecen en el resultado (no es un error).
    """
    pairs: list[tuple[str, str]] = []
    for full_name in table_names:
        parts = full_name.split(".")
        if len(parts) != 2:
            raise DbGuardRejected(
                f"'{full_name}' no tiene el formato esperado 'schema.tabla'."
            )
        pairs.append((parts[0], parts[1]))

    if not pairs:
        return {}

    values_clause = ", ".join(["(%s, %s)"] * len(pairs))
    flat_params: list[str] = [p for pair in pairs for p in pair]

    sql = f"""
        SELECT table_schema, table_name, column_name, data_type,
               is_nullable, column_default, ordinal_position
        FROM information_schema.columns
        WHERE (table_schema, table_name) IN ({values_clause})
        ORDER BY table_schema, table_name, ordinal_position
    """

    with _PooledConnection() as conn:
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, flat_params)
                rows = cur.fetchall()
        except psycopg2.Error as exc:
            sqlstate = getattr(exc, "pgcode", None)
            message = getattr(getattr(exc, "diag", None), "message_primary", None) or str(exc).strip()
            raise DbQueryError(message, sqlstate=sqlstate) from exc

    result: dict[str, list[dict]] = {}
    for row in rows:
        key = f"{row['table_schema']}.{row['table_name']}"
        result.setdefault(key, []).append(
            {
                "column_name": row["column_name"],
                "data_type": row["data_type"],
                "is_nullable": row["is_nullable"],
                "column_default": row["column_default"],
                "ordinal_position": row["ordinal_position"],
            }
        )
    return result


def health_check() -> bool:
    """True si se pudo conectar y correr `SELECT 1`. No lanza excepción propia: devuelve False."""
    try:
        rows = execute_select("SELECT 1 AS ok", apply_default_limit=False)
        return rows == [{"ok": 1}]
    except DbError:
        return False


if __name__ == "__main__":
    # Chequeo manual rápido: `python db.py` (requiere PGHOST/PGDATABASE/PGUSER/PGPASSWORD).
    try:
        cfg = DbConfig.from_env()
    except DbError as e:
        print(f"No configurado: {e}")
    else:
        print(f"Conectando a {cfg.user}@{cfg.host}:{cfg.port}/{cfg.dbname} ...")
        print("health_check():", health_check())
