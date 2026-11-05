"""auth.py — autenticación por bearer token para el transporte streamable-http.

Cada usuario del MCP tiene un token opaco aleatorio (generado por
scripts/create_user.py). En disco se guarda SOLO el SHA-256 del token, nunca
el token en claro: si alguien lee users.yaml no puede usarlo para conectarse.
SHA-256 sin salt alcanza porque los tokens son aleatorios de 256 bits (no
contraseñas elegidas por humanos), así que no hay diccionario que probar.

El archivo se relee cuando cambia su mtime, así que dar de alta, deshabilitar
o borrar un usuario no requiere reiniciar el servidor.

Formato de users.yaml:

    users:
      - name: juan
        rol: readonly
        database: default
        token_sha256: "<hex>"
        enabled: true
        created_at: "2026-09-23T15:00:00+00:00"
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from dataclasses import dataclass
from pathlib import Path

import yaml

from mcp.server.auth.provider import AccessToken, TokenVerifier

registrador = logging.getLogger("popey-mcp.auth")

ARCHIVO_USUARIOS_POR_DEFECTO = Path(__file__).resolve().parent.parent / "config" / "users.yaml"


def obtener_ruta_archivo_usuarios() -> Path:
    return Path(os.environ.get("MCP_USERS_FILE", ARCHIVO_USUARIOS_POR_DEFECTO))


def calcular_hash_token(token_en_claro: str) -> str:
    return hashlib.sha256(token_en_claro.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class User:
    name: str
    rol: str
    database: str
    token_sha256: str
    enabled: bool


def cargar_usuarios(ruta_archivo: Path) -> list[User]:
    if not ruta_archivo.exists():
        return []
    contenido_yaml = yaml.safe_load(ruta_archivo.read_text(encoding="utf-8")) or {}
    return [
        User(
            name=str(entrada_usuario["name"]),
            rol=str(entrada_usuario.get("rol", "readonly")),
            database=str(entrada_usuario.get("database", "default")),
            token_sha256=str(entrada_usuario["token_sha256"]).lower(),
            enabled=bool(entrada_usuario.get("enabled", True)),
        )
        for entrada_usuario in contenido_yaml.get("users") or []
    ]


class FileTokenVerifier(TokenVerifier):
    """TokenVerifier del SDK de MCP respaldado por users.yaml."""

    def __init__(self, path: Path) -> None:
        self._ruta_archivo = path
        self._ultima_modificacion: float | None = None
        self._usuarios: list[User] = []

    def _reload_if_changed(self) -> None:
        fecha_modificacion = self._ruta_archivo.stat().st_mtime if self._ruta_archivo.exists() else None
        if fecha_modificacion == self._ultima_modificacion:
            return
        self._usuarios = cargar_usuarios(self._ruta_archivo)
        self._ultima_modificacion = fecha_modificacion
        registrador.info("users file cargado: %s (%d usuarios)", self._ruta_archivo, len(self._usuarios))

    async def verify_token(self, token: str) -> AccessToken | None:
        self._reload_if_changed()
        hash_candidato = calcular_hash_token(token)
        for usuario in self._usuarios:
            # compare_digest: comparación en tiempo constante, no filtra por timing
            # cuántos caracteres del hash coincidieron.
            if usuario.enabled and hmac.compare_digest(usuario.token_sha256, hash_candidato):
                return AccessToken(
                    token=token,
                    client_id=usuario.name,
                    scopes=[usuario.rol],
                    subject=usuario.name,
                    claims={"database": usuario.database},
                )
        registrador.warning("token rechazado (hash=%s…)", hash_candidato[:8])
        return None
