-- Current RFC 9995 signatures only; no pre-launch transfer artifacts need compatibility.
ALTER TABLE provider_migration_exports DROP CONSTRAINT provider_migration_exports_signature_check;
ALTER TABLE provider_migration_exports ADD CONSTRAINT provider_migration_exports_signature_check
  CHECK (octet_length(signature) BETWEEN 128 AND 1024);
ALTER TABLE pending_migration_imports DROP CONSTRAINT pending_migration_imports_signature_check;
ALTER TABLE pending_migration_imports ADD CONSTRAINT pending_migration_imports_signature_check
  CHECK (octet_length(signature) BETWEEN 128 AND 1024);
