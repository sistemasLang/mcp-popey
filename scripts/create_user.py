"""Da de alta un usuario del MCP y muestra su token UNA sola vez.

Solo lo puede correr el admin con acceso de consola al servidor: no existe
ningún endpoint HTTP para crear usuarios.

Uso con Docker (desde el directorio del compose):

    docker compose exec popey-mcp python /app/scripts/create_user.py <nombre> --rol contador
    docker compose exec popey-mcp python /app/scripts/create_user.py <nombre> --rotate
    docker compose exec popey-mcp python /app/scripts/create_user.py <nombre> --disable

Uso sin Docker (desde la raíz del repo):

    .venv/bin/python scripts/create_user.py <nombre>

Genera un token aleatorio, guarda solo su SHA-256 en users.yaml (o en
MCP_USERS_FILE si está definido) e imprime el token en claro. El token no se
puede recuperar después: si se pierde, se genera uno nuevo con --rotate.

--disable revoca el acceso de un usuario existente (el servidor lo toma sin
reiniciar).

--rol define el rol del usuario (admin, contador, readonly). Al crear, si no
se pasa, queda readonly; con --rotate se conserva el rol actual salvo que se
pase uno nuevo.

--database define la clave de la base a la que se conecta el usuario
(default: "default", que usa las variables PG*). Cualquier otra clave <k>
requiere DB_<K>_DSN en el entorno del servidor. Con --rotate se conserva la
actual salvo que se pase una nueva.
"""

from __future__ import annotations

import argparse
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from auth import calcular_hash_token, obtener_ruta_archivo_usuarios  # noqa: E402

PATRON_NOMBRE_USUARIO = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
PATRON_CLAVE_BASE_DATOS = re.compile(r"^[a-z0-9_]{1,32}$")
ROLES_DISPONIBLES = ["admin", "contador", "readonly"]


def _guardar_usuarios(ruta_archivo: Path, usuarios: list[dict]) -> None:
    ruta_archivo.parent.mkdir(parents=True, exist_ok=True)
    ruta_archivo.write_text(
        yaml.safe_dump({"users": usuarios}, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )
    ruta_archivo.chmod(0o600)


def gestionar_usuario() -> int:
    analizador_argumentos = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    analizador_argumentos.add_argument("name", help="identificador del usuario (minúsculas, números, . _ -)")
    analizador_argumentos.add_argument("--rol", choices=ROLES_DISPONIBLES, help="rol del usuario (default: readonly)")
    analizador_argumentos.add_argument("--database", help="clave de la base del usuario (default: default)")
    acciones_excluyentes = analizador_argumentos.add_mutually_exclusive_group()
    acciones_excluyentes.add_argument(
        "--rotate", action="store_true", help="reemplaza el token de un usuario existente"
    )
    acciones_excluyentes.add_argument(
        "--disable", action="store_true", help="revoca el acceso de un usuario existente"
    )
    argumentos = analizador_argumentos.parse_args()

    nombre_usuario = argumentos.name.lower()
    if not PATRON_NOMBRE_USUARIO.match(nombre_usuario):
        analizador_argumentos.error("nombre inválido: usar 2-64 caracteres [a-z0-9._-]")
    if argumentos.database is not None and not PATRON_CLAVE_BASE_DATOS.match(argumentos.database):
        analizador_argumentos.error("database inválida: usar 1-32 caracteres [a-z0-9_]")

    ruta_archivo = obtener_ruta_archivo_usuarios()
    contenido_yaml = (
        yaml.safe_load(ruta_archivo.read_text(encoding="utf-8")) if ruta_archivo.exists() else None
    ) or {}
    usuarios: list[dict] = contenido_yaml.get("users") or []

    usuario_existente = next((usuario for usuario in usuarios if usuario["name"] == nombre_usuario), None)
    if argumentos.disable:
        if not usuario_existente:
            analizador_argumentos.error(f"el usuario '{nombre_usuario}' no existe")
        usuario_existente["enabled"] = False
        _guardar_usuarios(ruta_archivo, usuarios)
        print(f"Usuario '{nombre_usuario}' deshabilitado en {ruta_archivo}")
        return 0

    if usuario_existente and not argumentos.rotate:
        analizador_argumentos.error(
            f"el usuario '{nombre_usuario}' ya existe (usar --rotate para generarle un token nuevo)"
        )

    token_nuevo = secrets.token_urlsafe(32)
    entrada_usuario = {
        "name": nombre_usuario,
        "rol": argumentos.rol or (usuario_existente or {}).get("rol", "readonly"),
        "database": argumentos.database or (usuario_existente or {}).get("database", "default"),
        "token_sha256": calcular_hash_token(token_nuevo),
        "enabled": True,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if usuario_existente:
        usuarios[usuarios.index(usuario_existente)] = entrada_usuario
    else:
        usuarios.append(entrada_usuario)

    _guardar_usuarios(ruta_archivo, usuarios)

    print(f"Usuario '{nombre_usuario}' {'rotado' if usuario_existente else 'creado'} en {ruta_archivo}")
    print("Token (se muestra UNA sola vez, guardalo ahora):")
    print(token_nuevo)
    return 0


if __name__ == "__main__":
    raise SystemExit(gestionar_usuario())
