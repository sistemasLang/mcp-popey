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
única barrera real de acceso es el usuario read-only de Postgres + las
guardas de código en db.py (solo SELECT, una sentencia, sin palabras
prohibidas) — ver docstring de db.py.

ÚNICA EXCEPCIÓN bloqueante a esa política: si `circuito` no es uno de los
circuitos existentes, query_circuit y get_circuit_schema rechazan antes de
ejecutar nada. No es una tabla con problemas de status — es la ausencia de
un circuito de referencia contra el cual avisar; sin eso no hay nada
informativo que construir, así que no aplica "avisar y seguir".
"""

from __future__ import annotations

import logging
from typing import Any

import sqlglot
from sqlglot import exp

from mcp.server import MCPServer

import circuits
import db

# Nunca usar print() acá: con transporte stdio, stdout ES el canal JSON-RPC.
# Cualquier logging va por logging (stderr por default).
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("popey-mcp.server")

mcp = MCPServer(
    name="popey-erp",
    description=(
        "Consulta de solo lectura sobre la base de Popey ERP, organizada por "
        "circuitos de negocio (venta, compras, stock, etc.)."
    ),
)


# ---------------------------------------------------------------------------
# Helpers internos — no son tools, los usa query_circuit.
# ---------------------------------------------------------------------------


def _extract_tables(sql: str) -> tuple[list[str], list[str]]:
    """Tablas referenciadas por `sql`, en formato "schema.tabla", y warnings de parseo.

    Si sqlglot no puede parsear la query, devuelve ([], [warning]) — la
    ejecución sigue igual (ver política de warnings del módulo); el guardián
    real de "es un SELECT válido" es db.execute_select, no esto.

    Si una tabla no trae schema explícito (ej. `FROM entidadcp`), se asume
    "public" (el search_path por defecto de Postgres) y se avisa, porque es
    una suposición, no un hecho confirmado por el SQL.

    Los alias de CTE (`WITH x AS (...) SELECT * FROM x`) se excluyen: sqlglot
    los expone como exp.Table igual que una tabla real, pero no lo son.
    """
    try:
        tree = sqlglot.parse_one(sql, dialect="postgres")
    except Exception as exc:  # sqlglot.errors.ParseError y variantes internas
        return [], [f"No se pudieron determinar las tablas de la consulta (falló el parseo SQL): {exc}"]

    cte_names = {cte.alias for cte in tree.find_all(exp.CTE)}

    warnings: list[str] = []
    tables: list[str] = []
    seen: set[str] = set()
    for table in tree.find_all(exp.Table):
        if table.name in cte_names:
            continue
        schema = table.db or "public"
        if not table.db:
            warnings.append(
                f"'{table.name}' no especifica schema en la query; se asumió "
                f"'{schema}.{table.name}' para la validación contra el circuito."
            )
        full_name = f"{schema}.{table.name}"
        if full_name not in seen:
            seen.add(full_name)
            tables.append(full_name)
    return tables, warnings


def _build_table_warnings(circuito: str, referenced_tables: list[str]) -> tuple[list[str], list[str]]:
    """Devuelve (tablas_con_warning, warnings) — nunca bloqueante, ver política del módulo."""
    by_name = {t.table: t for t in circuits.get_tables(circuito)}
    flagged: list[str] = []
    warnings: list[str] = []
    for name in referenced_tables:
        info = by_name.get(name)
        if info is None:
            flagged.append(name)
            warnings.append(
                f"'{name}' no está en la lista de tablas del circuito '{circuito}' "
                "(no bloquea la ejecución, es solo informativo)."
            )
            continue
        table_flagged = False
        if info.needs_review:
            warnings.append(
                f"'{name}' está marcada needs_review en el circuito '{circuito}': "
                f"{info.notes or info.role}"
            )
            table_flagged = True
        if info.is_legacy:
            warnings.append(
                f"'{name}' es un esquema legacy en el circuito '{circuito}': "
                f"{info.notes or info.role}"
            )
            table_flagged = True
        if table_flagged:
            flagged.append(name)
    return flagged, warnings


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@mcp.tool()
def list_circuits() -> list[dict[str, str]]:
    """Lista los circuitos de negocio de Popey disponibles, con su descripción corta."""
    return [
        {"name": name, "description": circuits.get_description(name)}
        for name in circuits.list_circuits()
    ]


@mcp.tool()
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
    if not circuits.circuit_exists(circuito):
        raise ValueError(
            f"No existe el circuito '{circuito}'. Circuitos disponibles: "
            f"{', '.join(circuits.list_circuits())}"
        )

    referenced_tables, parse_warnings = _extract_tables(sql)
    flagged_tables, table_warnings = (
        _build_table_warnings(circuito, referenced_tables) if referenced_tables else ([], [])
    )
    all_warnings = [*parse_warnings, *table_warnings]

    final_sql = db.build_final_sql(sql)
    rows = db.execute_select(final_sql, params, apply_default_limit=False)

    # Auditoría: circuito pedido, SQL final ejecutado, y qué tablas generaron
    # warning (si las hubo). WARNING si hubo algo que avisar, INFO si no —
    # así se puede filtrar por nivel sin perder el registro de las queries
    # limpias. No cubre intentos rechazados por la guarda de db.py ni errores
    # de Postgres: esos nunca llegan a este punto (ver limitación abajo).
    logger.log(
        logging.WARNING if all_warnings else logging.INFO,
        "query_circuit circuito=%s sql=%r tablas_con_warning=%s warnings=%s",
        circuito,
        final_sql,
        flagged_tables,
        all_warnings,
    )

    return {"rows": rows, "warnings": all_warnings}


@mcp.tool()
def get_circuit_schema(circuito: str) -> dict[str, Any]:
    """Esquema completo de un circuito: metadata de negocio + columnas reales de Postgres.

    Pensado para que el modelo sepa qué tablas/columnas puede usar antes de
    escribir el `sql` de query_circuit. Junta circuits.get_tables(circuito)
    (role/key_columns/source/status/notes, la intención de negocio) con
    db.get_schema_info(...) (columnas reales tal como están hoy en la base).
    Si una tabla listada en circuits.yaml no existe en la base (o no se pudo
    introspeccionar), su `columns` viene vacío — no es un error.
    """
    circuit = circuits.get_circuit(circuito)  # CircuitNotFoundError con mensaje claro si no existe

    table_names = circuit.table_names()
    real_columns = db.get_schema_info(table_names) if table_names else {}

    tables = [
        {
            "table": t.table,
            "role": t.role,
            "key_columns": list(t.key_columns),
            "source": t.source,
            "status": list(t.status),
            "notes": t.notes,
            "columns": real_columns.get(t.table, []),
        }
        for t in circuit.tables
    ]

    pending_columns = [
        {
            "table": p.table,
            "column": p.column,
            "status": p.status,
            "description": p.description,
            "source": p.source,
        }
        for p in circuit.pending_columns
    ]

    return {
        "circuito": circuit.name,
        "description": circuit.description,
        "naming_note": circuit.naming_note,
        "docs": list(circuit.docs),
        "tables": tables,
        "pending_columns": pending_columns,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    db.init_pool()
    try:
        mcp.run()  # bloqueante; default transport="stdio"
    finally:
        db.close_pool()


if __name__ == "__main__":
    main()
