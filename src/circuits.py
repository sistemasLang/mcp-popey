"""circuits.py — puerta de entrada a config/circuits.yaml.

Los datos de negocio (qué circuitos existen, qué tablas tiene cada uno) viven
en `config/circuits.yaml`. Este módulo lo lee una sola vez (cacheado) y le
ofrece al resto del código — sobre todo a server.py — funciones simples para
preguntar cosas como "dame la lista de circuitos" o "dame las tablas
permitidas del circuito venta", sin que ese código sepa ni le importe que por
debajo hay un YAML.

circuits.yaml tiene los datos. circuits.py es la puerta de entrada para
consultarlos. Nada fuera de este módulo debería abrir el YAML directamente.
"""

from __future__ import annotations

import functools
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config" / "circuits.yaml"


class CircuitNotFoundError(KeyError):
    """Se pidió un circuito que no existe en circuits.yaml."""


@dataclass(frozen=True)
class TableInfo:
    """Una tabla/vista de PostgreSQL afectada por un circuito."""

    table: str
    role: str = ""
    key_columns: tuple[str, ...] = ()
    source: str = ""
    status: tuple[str, ...] = ()
    notes: str = ""

    @property
    def needs_review(self) -> bool:
        """True si esta entrada quedó marcada para revisión manual (ver naming_note del circuito)."""
        return "needs_review" in self.status

    @property
    def is_legacy(self) -> bool:
        """True si esta tabla es un esquema legacy/superseded, no el vigente."""
        return "legacy" in self.status


@dataclass(frozen=True)
class PendingColumn:
    """Una columna documentada como pendiente/no implementada todavía en la base."""

    table: str
    column: str
    status: str = ""
    description: str = ""
    source: str = ""


@dataclass(frozen=True)
class Circuit:
    """Un circuito de negocio: nombre, descripción y tablas asociadas."""

    name: str
    description: str = ""
    docs: tuple[str, ...] = ()
    naming_note: str = ""
    tables: tuple[TableInfo, ...] = ()
    pending_columns: tuple[PendingColumn, ...] = ()

    def table_names(self) -> tuple[str, ...]:
        """Nombres de tabla (schema.tabla) en el orden del YAML, sin deduplicar ni filtrar por status."""
        return tuple(t.table for t in self.tables)


def _coerce_status(raw: Any) -> tuple[str, ...]:
    """`status` puede venir como string suelto, lista, o ausente — siempre se normaliza a tupla."""
    if raw is None:
        return ()
    if isinstance(raw, str):
        return (raw,)
    return tuple(raw)


def _parse_table(raw: dict) -> TableInfo:
    return TableInfo(
        table=raw["table"],
        role=raw.get("role", ""),
        key_columns=tuple(raw.get("key_columns") or ()),
        source=raw.get("source", ""),
        status=_coerce_status(raw.get("status")),
        notes=raw.get("notes", ""),
    )


def _parse_pending_column(raw: dict) -> PendingColumn:
    return PendingColumn(
        table=raw.get("table", ""),
        column=raw.get("column", ""),
        status=raw.get("status", ""),
        description=raw.get("description", ""),
        source=raw.get("source", ""),
    )


def _parse_circuit(name: str, raw: dict) -> Circuit:
    return Circuit(
        name=name,
        description=raw.get("description", ""),
        docs=tuple(raw.get("docs") or ()),
        naming_note=raw.get("naming_note", ""),
        tables=tuple(_parse_table(t) for t in raw.get("tables") or ()),
        pending_columns=tuple(
            _parse_pending_column(p) for p in raw.get("pending_columns") or ()
        ),
    )


@functools.lru_cache(maxsize=None)
def _load(path: str) -> dict[str, Circuit]:
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    circuits_raw = raw.get("circuits") or {}
    return {name: _parse_circuit(name, data) for name, data in circuits_raw.items()}


def _resolve_path(path: str | Path | None) -> str:
    return str(Path(path)) if path is not None else str(DEFAULT_PATH)


# --------------------------------------------------------------------------
# API pública — esto es lo que el resto del código (server.py) debería usar.
# Ningún llamador necesita saber que por debajo hay un archivo YAML.
# --------------------------------------------------------------------------


def load_circuits(path: str | Path | None = None) -> dict[str, Circuit]:
    """Todos los circuitos como {nombre: Circuit}. Lee el YAML una sola vez por path (cacheado)."""
    return _load(_resolve_path(path))


def list_circuits(path: str | Path | None = None) -> list[str]:
    """Nombres de todos los circuitos definidos, en el orden del YAML."""
    return list(load_circuits(path).keys())


def circuit_exists(name: str, path: str | Path | None = None) -> bool:
    return name in load_circuits(path)


def get_circuit(name: str, path: str | Path | None = None) -> Circuit:
    """El objeto Circuit completo para `name`. Lanza CircuitNotFoundError si no existe."""
    circuits = load_circuits(path)
    try:
        return circuits[name]
    except KeyError:
        raise CircuitNotFoundError(
            f"No existe el circuito '{name}'. Circuitos disponibles: {', '.join(circuits)}"
        ) from None


def get_description(name: str, path: str | Path | None = None) -> str:
    """Descripción corta del circuito."""
    return get_circuit(name, path).description


def get_tables(name: str, path: str | Path | None = None) -> list[TableInfo]:
    """Objetos TableInfo completos del circuito (role, key_columns, source, status, notes)."""
    return list(get_circuit(name, path).tables)


def get_allowed_tables(name: str, path: str | Path | None = None) -> list[str]:
    """Nombres de tabla (schema.tabla) del circuito, en el orden del YAML.

    NOTA: por ahora devuelve TODAS las tablas listadas, incluidas las
    marcadas status: needs_review (ver naming_note de cada circuito en el
    YAML). Excluir needs_review es un paso aparte, todavía no implementado
    acá a propósito.
    """
    return list(get_circuit(name, path).table_names())


def get_pending_columns(name: str, path: str | Path | None = None) -> list[PendingColumn]:
    """Columnas documentadas como pendientes/no implementadas todavía para el circuito."""
    return list(get_circuit(name, path).pending_columns)


def reload(path: str | Path | None = None) -> None:
    """Invalida el cache y fuerza releer el YAML la próxima vez que se consulte."""
    _load.cache_clear()


if __name__ == "__main__":
    # Chequeo manual rápido: `python circuits.py`
    for circuit_name in list_circuits():
        n_tables = len(get_allowed_tables(circuit_name))
        n_review = sum(1 for t in get_tables(circuit_name) if t.needs_review)
        n_pending = len(get_pending_columns(circuit_name))
        extra = []
        if n_review:
            extra.append(f"{n_review} needs_review")
        if n_pending:
            extra.append(f"{n_pending} pending_columns")
        suffix = f" ({', '.join(extra)})" if extra else ""
        print(f"{circuit_name}: {n_tables} tablas{suffix}")
