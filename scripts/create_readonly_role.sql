-- create_readonly_role.sql — creates/updates the PostgreSQL role used by the MCP.
--
-- Grants ONLY: CONNECT, USAGE on allowed schemas, SELECT on their tables.
-- Never INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE.
-- The `seguridad` schema (passwords, recovery hashes, 2FA codes) only gets
-- COLUMN-LEVEL SELECT on the safe columns listed below, which must match the
-- key_columns of the `usuario` circuit in config/circuits.yaml. Never grant a
-- table-level SELECT there, and never add it to ALTER DEFAULT PRIVILEGES.
--
-- Run once per tenant database:
--   psql -U <owner> -d <database> -v ON_ERROR_STOP=1 \
--     -v ro_password='<password>' -v owner_role='<owner>' \
--     -f scripts/create_readonly_role.sql
--
-- The password is passed with -v so it never lives in this file.
-- If circuits.yaml adds a schema, add it to the lists below and re-run (idempotent).

SELECT format('CREATE ROLE mcp_popey_ro LOGIN PASSWORD %L', :'ro_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_popey_ro') \gexec

SELECT format('ALTER ROLE mcp_popey_ro LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'ro_password')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_popey_ro') \gexec

-- Session default: read-only, on top of the READ ONLY transactions the MCP opens.
ALTER ROLE mcp_popey_ro SET default_transaction_read_only = on;

SELECT format('GRANT CONNECT ON DATABASE %I TO mcp_popey_ro', current_database()) \gexec

-- PostgreSQL < 15 lets PUBLIC create objects in "public".
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- seguridad: start from zero on every run (REVOKE on a table also drops its
-- column privileges), then grant SELECT only on the safe columns that exist.
SELECT 'REVOKE ALL ON ALL TABLES IN SCHEMA seguridad FROM mcp_popey_ro'
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'seguridad') \gexec
SELECT 'GRANT USAGE ON SCHEMA seguridad TO mcp_popey_ro'
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'seguridad') \gexec

-- Safe columns per table. Keep in sync with circuits.yaml (circuit `usuario`);
-- a unit test fails if they drift apart.
SELECT format(
  'GRANT SELECT (%s) ON seguridad.%I TO mcp_popey_ro',
  string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
  c.relname
)
FROM (VALUES
  ('usuario', ARRAY['nusuario', 'vnombre', 'vapellido', 'vusuario', 'vemail', 'bhabilitado', 'tshabilitado', 'nusuariocreador', 'tscreado', 'tsactualizado']),
  ('usuarioxrol', ARRAY['nusuarioxrol', 'nusuario', 'nrol', 'ndeposito']),
  ('rol', ARRAY['nrol', 'vrol']),
  ('view_usuario', ARRAY['nusuario', 'vnombre', 'vapellido', 'vfullname', 'vusuario', 'vemail', 'bhabilitado', 'vhabilitado', 'vrol', 'nroles', 'broladmin', 'brolgerente', 'brolencargado', 'brolvendedor', 'brolcontador', 'brolsoporte', 'brolserviciotecnico', 'broldistribuidor', 'brolconsultor', 'brolfull', 'brolcajero', 'broldespacho'])
) AS allowed (table_name, column_names)
JOIN pg_namespace n ON n.nspname = 'seguridad'
JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = allowed.table_name
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY (allowed.column_names)
GROUP BY c.relname \gexec

GRANT USAGE ON SCHEMA
  administracion, compra, e_plataforma, ecommerce, mercado_libre, public,
  servicio_tecnico, stock, util, venta
  TO mcp_popey_ro;

GRANT SELECT ON ALL TABLES IN SCHEMA
  administracion, compra, e_plataforma, ecommerce, mercado_libre, public,
  servicio_tecnico, stock, util, venta
  TO mcp_popey_ro;

-- Future tables created by the owner role stay readable (and only readable).
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA administracion GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA compra GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA e_plataforma GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA ecommerce GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA mercado_libre GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA servicio_tecnico GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA stock GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA util GRANT SELECT ON TABLES TO mcp_popey_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA venta GRANT SELECT ON TABLES TO mcp_popey_ro;
