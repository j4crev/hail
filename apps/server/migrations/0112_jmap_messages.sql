-- Provider-local JMAP identities and change history. No signed objects are rewritten.
CREATE TABLE jmap_message_states (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  retained_from bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,generation)
);
CREATE TABLE jmap_messages (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  sender_did text NOT NULL,
  message_id uuid NOT NULL,
  destroyed boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX jmap_messages_live ON jmap_messages(account_id,generation,sender_did,message_id) WHERE NOT destroyed;
CREATE INDEX jmap_messages_owner ON jmap_messages(account_id,generation,id);
CREATE TABLE jmap_message_changes (
  account_id uuid NOT NULL,
  generation bigint NOT NULL,
  revision bigint NOT NULL,
  id uuid NOT NULL REFERENCES jmap_messages(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK(operation IN ('created','updated','destroyed')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,generation,revision),
  FOREIGN KEY(account_id,generation) REFERENCES jmap_message_states(account_id,generation) ON DELETE CASCADE
);
CREATE INDEX jmap_message_changes_expiry ON jmap_message_changes(account_id,generation,occurred_at);

CREATE FUNCTION hail_jmap_message_change(owner uuid, gen bigint, sender text, message uuid, action text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE record_id uuid; next_revision bigint; actual_action text;
BEGIN
  -- Serialize revisions before selecting the current incarnation. A database
  -- sequence alone cannot establish commit order for incremental synchronization.
  INSERT INTO jmap_message_states(account_id,generation) VALUES(owner,gen) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM jmap_message_states WHERE account_id=owner AND generation=gen FOR UPDATE;
  SELECT id INTO record_id FROM jmap_messages WHERE account_id=owner AND generation=gen
    AND sender_did=sender AND message_id=message AND NOT destroyed;
  IF record_id IS NULL AND action='destroyed' THEN RETURN; END IF;
  actual_action:=action;
  IF record_id IS NULL THEN
    record_id:=gen_random_uuid(); actual_action:='created';
    INSERT INTO jmap_messages(id,account_id,generation,sender_did,message_id)
      VALUES(record_id,owner,gen,sender,message);
  ELSIF action='destroyed' THEN
    UPDATE jmap_messages SET destroyed=true WHERE id=record_id;
  ELSE actual_action:='updated'; END IF;
  UPDATE jmap_message_states SET revision=revision+1 WHERE account_id=owner AND generation=gen RETURNING revision INTO next_revision;
  INSERT INTO jmap_message_changes(account_id,generation,revision,id,operation)
    VALUES(owner,gen,next_revision,record_id,actual_action);
END $$;

CREATE FUNCTION hail_jmap_track_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item delivered_messages%ROWTYPE; owner uuid; gen bigint;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN item:=OLD; ELSE item:=NEW; END IF;
  SELECT a.id,g.generation INTO owner,gen FROM provider_accounts a
    JOIN account_serving_generations g ON g.account_id=a.id WHERE a.did=item.recipient_did;
  IF owner IS NOT NULL THEN
    PERFORM hail_jmap_message_change(owner,gen,item.sender_did,item.message_id,
      CASE WHEN TG_OP='DELETE' THEN 'destroyed' ELSE 'updated' END);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jmap_track_message AFTER INSERT OR UPDATE OR DELETE ON delivered_messages
  FOR EACH ROW EXECUTE FUNCTION hail_jmap_track_message();

CREATE FUNCTION hail_jmap_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item delivered_messages%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND NEW.generation=OLD.generation THEN RETURN NEW; END IF;
  INSERT INTO jmap_message_states(account_id,generation) VALUES(NEW.account_id,NEW.generation) ON CONFLICT DO NOTHING;
  FOR item IN SELECT d.* FROM delivered_messages d JOIN provider_accounts a ON a.did=d.recipient_did
    WHERE a.id=NEW.account_id ORDER BY d.sender_did,d.message_id LOOP
    PERFORM hail_jmap_message_change(NEW.account_id,NEW.generation,item.sender_did,item.message_id,'created');
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER jmap_generation AFTER INSERT OR UPDATE OF generation ON account_serving_generations
  FOR EACH ROW EXECUTE FUNCTION hail_jmap_generation();

INSERT INTO jmap_message_states(account_id,generation) SELECT account_id,generation FROM account_serving_generations;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT a.id,g.generation,d.sender_did,d.message_id FROM delivered_messages d
    JOIN provider_accounts a ON a.did=d.recipient_did JOIN account_serving_generations g ON g.account_id=a.id
    ORDER BY a.id,d.sender_did,d.message_id LOOP
    PERFORM hail_jmap_message_change(item.id,item.generation,item.sender_did,item.message_id,'created');
  END LOOP;
END $$;
