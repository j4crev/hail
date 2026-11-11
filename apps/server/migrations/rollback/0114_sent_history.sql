BEGIN;
ALTER TABLE publication_targets DROP CONSTRAINT publication_targets_grant_id_fkey;
ALTER TABLE publication_targets ADD CONSTRAINT publication_targets_grant_id_fkey
  FOREIGN KEY(grant_id) REFERENCES grant_lineages(grant_id) ON DELETE RESTRICT;
DELETE FROM schema_migrations WHERE version=114;
COMMIT;
