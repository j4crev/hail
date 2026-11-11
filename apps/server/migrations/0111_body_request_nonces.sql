CREATE TABLE body_request_nonces (
  recipient_did text NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=32),
  expires_at bigint NOT NULL,
  PRIMARY KEY(recipient_did,nonce)
);
CREATE INDEX body_request_nonces_expiry ON body_request_nonces(expires_at);
