-- Sanitized outcome only: never store push response bodies or endpoint secrets.
ALTER TABLE jmap_push_subscriptions ADD COLUMN verification_error text
 CHECK (verification_error IN ('pushServiceRejected','deliveryFailed'));
