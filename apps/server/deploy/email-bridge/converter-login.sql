-- Creates or updates the converter's login role, a member of hail_email_converter
-- (see converter-role.sql). Run as the database owner with psql after setting
-- the password, which must be unpadded base64url:
--
--   \set password 'THE-PASSWORD'
--   \i converter-login.sql
--
-- The role's name is email_converter, which the Compose files use.
SELECT format('CREATE ROLE email_converter LOGIN PASSWORD %L', :'password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_converter') \gexec
-- Plain syntax that PostgreSQL 14 and later all accept.
ALTER ROLE email_converter WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD :'password';
GRANT hail_email_converter TO email_converter;
