-- Provider-local JMAP identities and change history. Draft content and protocol send IDs remain unchanged.
CREATE TABLE jmap_draft_states (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  retained_from bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,generation)
);
CREATE TABLE jmap_drafts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  draft_id uuid NOT NULL,
  destroyed boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX jmap_drafts_live ON jmap_drafts(account_id,generation,draft_id) WHERE NOT destroyed;
CREATE INDEX jmap_drafts_owner ON jmap_drafts(account_id,generation,id);
CREATE TABLE jmap_draft_changes (
  account_id uuid NOT NULL,
  generation bigint NOT NULL,
  revision bigint NOT NULL,
  id uuid NOT NULL REFERENCES jmap_drafts(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK(operation IN ('created','updated','destroyed')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,generation,revision),
  FOREIGN KEY(account_id,generation) REFERENCES jmap_draft_states(account_id,generation) ON DELETE CASCADE
);
CREATE INDEX jmap_draft_changes_expiry ON jmap_draft_changes(account_id,generation,occurred_at);

CREATE FUNCTION hail_jmap_draft_change(owner uuid, gen bigint, draft uuid, action text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE record_id uuid; next_revision bigint; actual_action text;
BEGIN
  -- Serialize revisions before selecting the current incarnation. A database
  -- sequence alone cannot establish commit order for incremental synchronization.
  INSERT INTO jmap_draft_states(account_id,generation) VALUES(owner,gen) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM jmap_draft_states WHERE account_id=owner AND generation=gen FOR UPDATE;
  SELECT id INTO record_id FROM jmap_drafts WHERE account_id=owner AND generation=gen
    AND draft_id=draft AND NOT destroyed;
  IF record_id IS NULL AND action='destroyed' THEN RETURN; END IF;
  actual_action:=action;
  IF record_id IS NULL THEN
    record_id:=gen_random_uuid(); actual_action:='created';
    INSERT INTO jmap_drafts(id,account_id,generation,draft_id)
      VALUES(record_id,owner,gen,draft);
  ELSIF action='destroyed' THEN
    UPDATE jmap_drafts SET destroyed=true WHERE id=record_id;
  ELSE actual_action:='updated'; END IF;
  UPDATE jmap_draft_states SET revision=revision+1 WHERE account_id=owner AND generation=gen RETURNING revision INTO next_revision;
  INSERT INTO jmap_draft_changes(account_id,generation,revision,id,operation)
    VALUES(owner,gen,next_revision,record_id,actual_action);
END $$;

CREATE FUNCTION hail_jmap_track_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item account_message_drafts%ROWTYPE; owner uuid; gen bigint;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.account_id<>OLD.account_id OR NEW.id<>OLD.id) THEN
    RAISE EXCEPTION 'Draft identity is immutable';
  END IF;
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN item:=OLD; ELSE item:=NEW; END IF;
  owner:=item.account_id;
  SELECT generation INTO gen FROM account_serving_generations WHERE account_id=owner;
  IF gen IS NOT NULL THEN
    PERFORM hail_jmap_draft_change(owner,gen,item.id,
      CASE WHEN TG_OP='DELETE' THEN 'destroyed' ELSE 'updated' END);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jmap_track_draft AFTER INSERT OR UPDATE OR DELETE ON account_message_drafts
  FOR EACH ROW EXECUTE FUNCTION hail_jmap_track_draft();

CREATE FUNCTION hail_jmap_draft_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item account_message_drafts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND NEW.generation=OLD.generation THEN RETURN NEW; END IF;
  INSERT INTO jmap_draft_states(account_id,generation) VALUES(NEW.account_id,NEW.generation) ON CONFLICT DO NOTHING;
  FOR item IN SELECT * FROM account_message_drafts WHERE account_id=NEW.account_id ORDER BY id LOOP
    PERFORM hail_jmap_draft_change(NEW.account_id,NEW.generation,item.id,'created');
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER jmap_draft_generation AFTER INSERT OR UPDATE OF generation ON account_serving_generations
  FOR EACH ROW EXECUTE FUNCTION hail_jmap_draft_generation();

INSERT INTO jmap_draft_states(account_id,generation) SELECT account_id,generation FROM account_serving_generations;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT d.account_id,g.generation,d.id FROM account_message_drafts d
    JOIN account_serving_generations g ON g.account_id=d.account_id ORDER BY d.account_id,d.id LOOP
    PERFORM hail_jmap_draft_change(item.account_id,item.generation,item.id,'created');
  END LOOP;
END $$;
