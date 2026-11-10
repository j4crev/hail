BEGIN;
-- Fail instead of discarding newly signed artifacts. Application rollback also
-- requires support for newly written envelope representations; see cutover notes.
ALTER TABLE provider_migration_exports DROP CONSTRAINT provider_migration_exports_signature_check;
ALTER TABLE provider_migration_exports ADD CONSTRAINT provider_migration_exports_signature_check CHECK (octet_length(signature)=64);
ALTER TABLE pending_migration_imports DROP CONSTRAINT pending_migration_imports_signature_check;
ALTER TABLE pending_migration_imports ADD CONSTRAINT pending_migration_imports_signature_check CHECK (octet_length(signature)=64);

DELETE FROM schema_migrations WHERE version=109;
COMMIT;
