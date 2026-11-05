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

RUTA_YAML_POR_DEFECTO = Path(__file__).resolve().parent.parent / "config" / "circuits.yaml"


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
        return tuple(tabla.table for tabla in self.tables)


@dataclass(frozen=True)
class RoleCircuit:
    """Tablas visibles para un rol de usuario (sección circuits_rol del YAML)."""

    rol: str
    description: str = ""
    tables: tuple[str, ...] = ()


def _normalizar_estado(estado_crudo: Any) -> tuple[str, ...]:
    """`status` puede venir como string suelto, lista, o ausente — siempre se normaliza a tupla."""
    if estado_crudo is None:
        return ()
    if isinstance(estado_crudo, str):
        return (estado_crudo,)
    return tuple(estado_crudo)


def _parsear_tabla(datos_tabla: dict) -> TableInfo:
    return TableInfo(
        table=datos_tabla["table"],
        role=datos_tabla.get("role", ""),
        key_columns=tuple(datos_tabla.get("key_columns") or ()),
        source=datos_tabla.get("source", ""),
        status=_normalizar_estado(datos_tabla.get("status")),
        notes=datos_tabla.get("notes", ""),
    )


def _parsear_columna_pendiente(datos_columna: dict) -> PendingColumn:
    return PendingColumn(
        table=datos_columna.get("table", ""),
        column=datos_columna.get("column", ""),
        status=datos_columna.get("status", ""),
        description=datos_columna.get("description", ""),
        source=datos_columna.get("source", ""),
    )


def _parsear_circuito(nombre_circuito: str, datos_circuito: dict) -> Circuit:
    return Circuit(
        name=nombre_circuito,
        description=datos_circuito.get("description", ""),
        docs=tuple(datos_circuito.get("docs") or ()),
        naming_note=datos_circuito.get("naming_note", ""),
        tables=tuple(_parsear_tabla(datos_tabla) for datos_tabla in datos_circuito.get("tables") or ()),
        pending_columns=tuple(
            _parsear_columna_pendiente(datos_columna)
            for datos_columna in datos_circuito.get("pending_columns") or ()
        ),
    )


def _parsear_circuito_de_rol(rol: str, datos_rol: dict) -> RoleCircuit:
    return RoleCircuit(
        rol=rol,
        description=datos_rol.get("description", ""),
        tables=tuple(datos_rol.get("tables") or ()),
    )


@functools.lru_cache(maxsize=None)
def _leer_yaml(ruta_yaml: str) -> dict:
    with open(ruta_yaml, "r", encoding="utf-8") as archivo:
        return yaml.safe_load(archivo) or {}


@functools.lru_cache(maxsize=None)
def _cargar_circuitos_desde_yaml(ruta_yaml: str) -> dict[str, Circuit]:
    circuitos_crudos = _leer_yaml(ruta_yaml).get("circuits") or {}
    return {
        nombre_circuito: _parsear_circuito(nombre_circuito, datos_circuito)
        for nombre_circuito, datos_circuito in circuitos_crudos.items()
    }


@functools.lru_cache(maxsize=None)
def _cargar_roles_desde_yaml(ruta_yaml: str) -> dict[str, RoleCircuit]:
    roles_crudos = _leer_yaml(ruta_yaml).get("circuits_rol") or {}
    return {rol: _parsear_circuito_de_rol(rol, datos_rol) for rol, datos_rol in roles_crudos.items()}


def _resolver_ruta(ruta_yaml: str | Path | None) -> str:
    return str(Path(ruta_yaml)) if ruta_yaml is not None else str(RUTA_YAML_POR_DEFECTO)


# --------------------------------------------------------------------------
# API pública — esto es lo que el resto del código (server.py) debería usar.
# Ningún llamador necesita saber que por debajo hay un archivo YAML.
# --------------------------------------------------------------------------


def cargar_circuitos(ruta_yaml: str | Path | None = None) -> dict[str, Circuit]:
    """Todos los circuitos como {nombre: Circuit}. Lee el YAML una sola vez por path (cacheado)."""
    return _cargar_circuitos_desde_yaml(_resolver_ruta(ruta_yaml))


def listar_circuitos(ruta_yaml: str | Path | None = None) -> list[str]:
    """Nombres de todos los circuitos definidos, en el orden del YAML."""
    return list(cargar_circuitos(ruta_yaml).keys())


def existe_circuito(nombre_circuito: str, ruta_yaml: str | Path | None = None) -> bool:
    return nombre_circuito in cargar_circuitos(ruta_yaml)


def obtener_circuito(nombre_circuito: str, ruta_yaml: str | Path | None = None) -> Circuit:
    """El objeto Circuit completo para `nombre_circuito`. Lanza CircuitNotFoundError si no existe."""
    circuitos = cargar_circuitos(ruta_yaml)
    try:
        return circuitos[nombre_circuito]
    except KeyError:
        raise CircuitNotFoundError(
            f"No existe el circuito '{nombre_circuito}'. Circuitos disponibles: {', '.join(circuitos)}"
        ) from None


def obtener_descripcion(nombre_circuito: str, ruta_yaml: str | Path | None = None) -> str:
    """Descripción corta del circuito."""
    return obtener_circuito(nombre_circuito, ruta_yaml).description


def obtener_tablas(nombre_circuito: str, ruta_yaml: str | Path | None = None) -> list[TableInfo]:
    """Objetos TableInfo completos del circuito (role, key_columns, source, status, notes)."""
    return list(obtener_circuito(nombre_circuito, ruta_yaml).tables)


def obtener_nombres_tablas_permitidas(nombre_circuito: str, ruta_yaml: str | Path | None = None) -> list[str]:
    """Nombres de tabla (schema.tabla) del circuito, en el orden del YAML.

    NOTA: por ahora devuelve TODAS las tablas listadas, incluidas las
    marcadas status: needs_review (ver naming_note de cada circuito en el
    YAML). Excluir needs_review es un paso aparte, todavía no implementado
    acá a propósito.
    """
    return list(obtener_circuito(nombre_circuito, ruta_yaml).table_names())


def obtener_columnas_pendientes(nombre_circuito: str, ruta_yaml: str | Path | None = None) -> list[PendingColumn]:
    """Columnas documentadas como pendientes/no implementadas todavía para el circuito."""
    return list(obtener_circuito(nombre_circuito, ruta_yaml).pending_columns)


def listar_roles(ruta_yaml: str | Path | None = None) -> list[str]:
    """Roles definidos en circuits_rol, en el orden del YAML."""
    return list(_cargar_roles_desde_yaml(_resolver_ruta(ruta_yaml)).keys())


def obtener_circuito_de_rol(rol: str, ruta_yaml: str | Path | None = None) -> RoleCircuit:
    """Tablas visibles para `rol`. Lanza CircuitNotFoundError si el rol no está en circuits_rol."""
    circuitos_por_rol = _cargar_roles_desde_yaml(_resolver_ruta(ruta_yaml))
    try:
        return circuitos_por_rol[rol]
    except KeyError:
        raise CircuitNotFoundError(
            f"No hay circuito definido para el rol '{rol}'. Roles disponibles: {', '.join(circuitos_por_rol)}"
        ) from None


def recargar_yaml(ruta_yaml: str | Path | None = None) -> None:
    """Invalida el cache y fuerza releer el YAML la próxima vez que se consulte."""
    _leer_yaml.cache_clear()
    _cargar_circuitos_desde_yaml.cache_clear()
    _cargar_roles_desde_yaml.cache_clear()


if __name__ == "__main__":
    # Chequeo manual rápido: `python circuits.py`
    for nombre_circuito in listar_circuitos():
        cantidad_tablas = len(obtener_nombres_tablas_permitidas(nombre_circuito))
        cantidad_a_revisar = sum(1 for tabla in obtener_tablas(nombre_circuito) if tabla.needs_review)
        cantidad_columnas_pendientes = len(obtener_columnas_pendientes(nombre_circuito))
        detalles = []
        if cantidad_a_revisar:
            detalles.append(f"{cantidad_a_revisar} needs_review")
        if cantidad_columnas_pendientes:
            detalles.append(f"{cantidad_columnas_pendientes} pending_columns")
        sufijo = f" ({', '.join(detalles)})" if detalles else ""
        print(f"{nombre_circuito}: {cantidad_tablas} tablas{sufijo}")
