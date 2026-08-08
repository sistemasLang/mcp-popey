-- create_readonly_role.sql — (re)crea el rol Postgres read-only que usa
-- MCP-Popey (PGUSER en .env).
--
-- Por qué existe este script: la base de dev corre en un contenedor Docker
-- (lang_docker_database_1) sin volumen persistente — cada vez que el
-- contenedor se recrea, el rol se pierde junto con el resto del cluster de
-- Postgres. Este script lo recrea de forma reproducible en vez de dejarlo
-- documentado solo como comandos sueltos en una conversación.
--
-- Uso:
--   docker cp scripts/create_readonly_role.sql lang_docker_database_1:/tmp/
--   docker exec -it lang_docker_database_1 \
--     psql -U langdev -d langdev -v ON_ERROR_STOP=1 \
--     -v ro_password='<elegir una password>' \
--     -f /tmp/create_readonly_role.sql
--
-- El :'ro_password' se pasa por -v a propósito: así la password nunca queda
-- hardcodeada ni commiteada en este archivo. Después de correrlo, poner esa
-- misma password en PGPASSWORD del .env (PGUSER=mcp_popey_ro).
--
-- Los schemas de la lista son los que hoy aparecen en config/circuits.yaml
-- (grep -oP '(?<=table: )\S+' config/circuits.yaml | cut -d. -f1 | sort -u).
-- Si circuits.yaml suma un circuito en un schema nuevo, hay que agregar ese
-- schema acá también (y volver a correr el script — los GRANT son
-- idempotentes).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_popey_ro') THEN
    EXECUTE format('CREATE ROLE mcp_popey_ro LOGIN PASSWORD %L', :'ro_password');
  ELSE
    EXECUTE format('ALTER ROLE mcp_popey_ro LOGIN PASSWORD %L', :'ro_password');
  END IF;
END
$$;

GRANT CONNECT ON DATABASE langdev TO mcp_popey_ro;

-- Default de Postgres <15: el schema "public" otorga CREATE a PUBLIC (el
-- pseudo-rol), así que CUALQUIER rol lo hereda sin que se lo demos a mano
-- (incluido mcp_popey_ro, rompiendo el chequeo de "rol read-only" de db.py
-- que mira has_schema_privilege(..., 'CREATE')). Esto NO afecta el SELECT
-- sobre las tablas que ya existen en public (eso se otorga aparte, más
-- abajo) — solo saca la capacidad de crear objetos nuevos. Tampoco afecta a
-- langdev: tiene su propio grant explícito de USAGE+CREATE como dueño.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA
  administracion, compra, e_plataforma, mercado_libre, public,
  servicio_tecnico, stock, util, venta
  TO mcp_popey_ro;

GRANT SELECT ON ALL TABLES IN SCHEMA
  administracion, compra, e_plataforma, mercado_libre, public,
  servicio_tecnico, stock, util, venta
  TO mcp_popey_ro;

-- Para que las tablas creadas a futuro en estos schemas por el rol dueño
-- (langdev) también queden en modo lectura para mcp_popey_ro sin tener que
-- volver a correr el GRANT a mano.
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA administracion GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA compra GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA e_plataforma GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA mercado_libre GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA public GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA servicio_tecnico GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA stock GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA util GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE langdev IN SCHEMA venta GRANT SELECT ON TABLES TO mcp_popey_ro;
