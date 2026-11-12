-- Wake connected JMAP event streams when an account's state changes, instead of
-- each stream polling every two seconds. NOTIFY is delivered only on commit (and
-- identical notifications in one transaction are delivered once); the payload is
-- the account ID only. Streams still poll slowly in case a notification is lost.
CREATE FUNCTION hail_notify_jmap_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('hail_jmap_state', NEW.account_id::text);
  RETURN NULL;
END $$;
CREATE TRIGGER jmap_message_states_notify AFTER INSERT OR UPDATE ON jmap_message_states
  FOR EACH ROW EXECUTE FUNCTION hail_notify_jmap_state();
CREATE TRIGGER jmap_draft_states_notify AFTER INSERT OR UPDATE ON jmap_draft_states
  FOR EACH ROW EXECUTE FUNCTION hail_notify_jmap_state();
CREATE TRIGGER jmap_collection_states_notify AFTER INSERT OR UPDATE ON jmap_collection_states
  FOR EACH ROW EXECUTE FUNCTION hail_notify_jmap_state();
