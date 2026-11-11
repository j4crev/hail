BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM body_request_nonces WHERE expires_at>=floor(extract(epoch FROM clock_timestamp()))) THEN
    RAISE EXCEPTION 'Unexpired retrieval nonces prevent rollback';
  END IF;
END $$;
DROP TABLE body_request_nonces;
DELETE FROM schema_migrations WHERE version=111;
COMMIT;
