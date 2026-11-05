#!/usr/bin/env bash
# create_readonly_role.sh — (re)crea el rol read-only mcp_popey_ro en la base
# de dev corriendo create_readonly_role.sql dentro del contenedor de Postgres.
#
# Toma la password de PGPASSWORD en el .env, así el rol queda siempre con la
# misma password que usa el MCP y no hay que tipearla ni dejarla en el
# historial del shell.
#
# Uso:
#   scripts/create_readonly_role.sh
#
# Variables opcionales:
#   DB_CONTAINER   contenedor de Postgres (default: lang_docker_database_1)
#   DB_SUPERUSER   rol dueño con el que se corre el script (default: langdev)
#   DB_NAME        base de datos (default: langdev)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
SQL_FILE="$ROOT_DIR/scripts/create_readonly_role.sql"

DB_CONTAINER="${DB_CONTAINER:-lang_docker_database_1}"
DB_SUPERUSER="${DB_SUPERUSER:-langdev}"
DB_NAME="${DB_NAME:-langdev}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No existe $ENV_FILE (copiar .env.example y completar PGPASSWORD)." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${PGPASSWORD:-}" ]]; then
  echo "PGPASSWORD está vacío en $ENV_FILE." >&2
  exit 1
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null)" != "true" ]]; then
  echo "El contenedor $DB_CONTAINER no está corriendo." >&2
  exit 1
fi

# El SQL entra por stdin: evita el docker cp y no deja el archivo en /tmp del
# contenedor.
docker exec -i "$DB_CONTAINER" \
  psql -U "$DB_SUPERUSER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -v ro_password="$PGPASSWORD" <"$SQL_FILE"

echo "Rol mcp_popey_ro listo en $DB_CONTAINER/$DB_NAME."
