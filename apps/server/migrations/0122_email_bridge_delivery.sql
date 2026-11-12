-- The hail each converted message becomes. Assigned once, before the first
-- delivery attempt, so retries reuse the same envelope.
ALTER TABLE email_bridge_intake ADD COLUMN message_id uuid UNIQUE;
ALTER TABLE email_bridge_intake ADD CHECK (state <> 'delivered' OR message_id IS NOT NULL);
