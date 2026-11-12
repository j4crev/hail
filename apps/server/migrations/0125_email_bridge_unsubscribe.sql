-- Permanent edge refusals survive account removal; sequence publication is serialized.
CREATE TABLE email_bridge_deletions (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  local_part text NOT NULL UNIQUE CHECK (local_part ~ '^[a-z2-7]{12}$')
);
INSERT INTO email_bridge_deletions(local_part)
  SELECT local_part FROM email_bridge_aliases WHERE state = 'deleted' ORDER BY deleted_at, id;

-- Only alias deletion with explicit consent creates jobs. URLs are bearer secrets:
-- do not log them, and erase them when attempts finish.
CREATE TABLE email_bridge_unsubscriptions (
  id uuid PRIMARY KEY,
  alias_id uuid NOT NULL REFERENCES email_bridge_aliases(id) ON DELETE CASCADE,
  url text CHECK (octet_length(url) <= 4096),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','requested','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((url IS NOT NULL) = (state = 'queued'))
);
CREATE INDEX email_bridge_unsubscriptions_work ON email_bridge_unsubscriptions(next_attempt_at) WHERE state = 'queued';
