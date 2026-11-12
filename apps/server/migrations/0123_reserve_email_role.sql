-- The email bridge sends as a provider-operated account. Reserve its usual name
-- so nobody else can register it; the operator claims it as a provider role.
INSERT INTO provider_reserved_names (local_part) VALUES ('email') ON CONFLICT DO NOTHING;
