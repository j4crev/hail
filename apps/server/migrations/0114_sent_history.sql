-- Return activation replaces Grant projections in one transaction while keeping
-- immutable publication intent/audiences. Enforce their references at commit.
ALTER TABLE publication_targets DROP CONSTRAINT publication_targets_grant_id_fkey;
ALTER TABLE publication_targets ADD CONSTRAINT publication_targets_grant_id_fkey
  FOREIGN KEY(grant_id) REFERENCES grant_lineages(grant_id) ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
