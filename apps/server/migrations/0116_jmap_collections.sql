-- Derived, provider-local collections. Refresh once at transaction completion,
-- including writes made by federation, retention and migration workers.
CREATE FUNCTION hail_jmap_b64(data bytea) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT translate(replace(encode(data,'base64'),E'\n',''),'+/=','-_')
$$;
CREATE VIEW jmap_live_objects AS
 SELECT i.account_id,'HailSent'::text AS collection,i.kind||'/'||i.id::text AS key,
   jsonb_build_object('sendId',i.id,'kind',i.kind,'category',i.category,'createdAt',i.created_at,
     'isInTrash',d.send_id IS NOT NULL,'trashedAt',d.trashed_at,'bodyDigest',hail_jmap_b64(sha256(i.body_bytes))) AS data
 FROM account_sent_items i LEFT JOIN account_sent_dispositions d ON d.account_id=i.account_id AND d.kind=i.kind AND d.send_id=i.id
 WHERE (d.deleted IS NULL OR NOT d.deleted) AND EXISTS(SELECT 1 FROM account_sent_members m WHERE m.account_id=i.account_id AND m.kind=i.kind AND m.send_id=i.id AND m.submitted)
 UNION ALL
 SELECT i.account_id,'HailSubmission',i.kind||'/'||i.id::text,
   jsonb_build_object('sendId',i.id,'kind',i.kind,'category',i.category,'createdAt',i.created_at,
     'bodyDigest',hail_jmap_b64(sha256(i.body_bytes)),
     'targets',COALESCE((SELECT jsonb_agg(jsonb_build_object('messageId',m.message_id,'submitted',m.submitted,'completed',COALESCE(m.completed,false),
       'deliveryState',s.current_state,'deliveryRevision',s.current_revision,'submissionState',COALESCE(pt.state,ct.state,'submitted'),
       'recipientDid',COALESCE(e.recipient_did,pt.recipient_did,ct.recipient_did),'envelope',hail_jmap_b64(e.envelope_cose)) ORDER BY m.message_id)
       FROM account_sent_members m LEFT JOIN sent_envelopes e ON e.sender_account_id=m.account_id AND e.message_id=m.message_id
       LEFT JOIN publication_targets pt ON pt.account_id=m.account_id AND pt.message_id=m.message_id
       LEFT JOIN connection_message_targets ct ON ct.account_id=m.account_id AND ct.message_id=m.message_id
       LEFT JOIN sent_delivery_status s ON s.sender_did=e.sender_did AND s.message_id=e.message_id
       WHERE m.account_id=i.account_id AND m.kind=i.kind AND m.send_id=i.id),'[]'::jsonb))
 FROM account_sent_items i
 UNION ALL
 SELECT owners.account_id,'HailGrant',l.grant_id::text,
   jsonb_build_object('grantId',l.grant_id,'localRole',owners.role,'grantor',l.grantor_did,'grantee',l.grantee_did,
     'revision',l.current_revision,'status',l.current_status,'digest',hail_jmap_b64(l.current_digest),'cose',hail_jmap_b64(r.cose))
 FROM grant_lineages l JOIN grant_revisions r ON r.grant_id=l.grant_id AND r.revision=l.current_revision
 CROSS JOIN LATERAL (SELECT l.local_account_id AS account_id,l.local_role AS role UNION
   SELECT c.grantee_account_id,'grantee' FROM collocated_grant_receivers c WHERE c.grant_id=l.grant_id) owners
 UNION ALL
 SELECT p.account_id,'HailRelationship',p.id::text,
   jsonb_build_object('kind','connection','pairId',p.id,'connectionId',p.connection_id,'peerDid',p.peer_did,'peerAddress',p.peer_address,
     'state',p.state,'epoch',p.epoch,'updatedAt',p.updated_at,
     'unseen',EXISTS(SELECT 1 FROM connection_unseen u WHERE u.account_id=p.account_id AND u.connection_id=p.connection_id AND u.epoch=p.epoch AND u.seen_at IS NULL))
 FROM federated_connection_pairs p WHERE p.state<>'empty'
 UNION ALL SELECT account_id,'HailRelationship','invitation/'||id::text,
   jsonb_build_object('kind','invitation','invitationId',id,'personal',personal,'label',label,'expiresAt',expires_at,'revokedAt',revoked_at)
 FROM connection_invitations
 UNION ALL SELECT account_id,'HailRelationship','attempt/'||id::text,
   jsonb_build_object('kind','attempt','attemptId',id,'pairId',pair_id,'direction',direction,'state',state,'expiresAt',expires_at)
 FROM federated_connection_attempts
 UNION ALL SELECT account_id,'HailRelationship','preferences',
   jsonb_build_object('kind','preferences','allowIntroductions',allow_introductions,'updatedAt',updated_at)
 FROM account_conversation_preferences
 UNION ALL SELECT account_id,'HailRelationship','connection-preferences/'||connection_id::text||'/'||epoch::text,
   jsonb_build_object('kind','connectionPreferences','connectionId',connection_id,'epoch',epoch,'allowIntroductions',allow_introductions,'updatedAt',updated_at)
 FROM connection_conversation_preferences
 UNION ALL SELECT account_id,'HailRelationship','membership/'||creator_did||'/'||conversation_id::text,
   jsonb_build_object('kind','membership','creatorDid',creator_did,'conversationId',conversation_id,'state',state,'expiresAt',expires_at,'leftAt',left_at)
 FROM conversation_memberships;
CREATE TABLE jmap_collection_states (
 account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
 generation bigint NOT NULL,collection text NOT NULL,
 revision bigint NOT NULL DEFAULT 0,retained_from bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id,generation,collection)
);
CREATE TABLE jmap_objects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
 generation bigint NOT NULL,collection text NOT NULL,key text NOT NULL,data jsonb NOT NULL,destroyed boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX jmap_objects_live ON jmap_objects(account_id,generation,collection,key) WHERE NOT destroyed;
CREATE INDEX jmap_objects_owner ON jmap_objects(account_id,generation,collection,id);
CREATE TABLE jmap_collection_changes (
 account_id uuid NOT NULL,generation bigint NOT NULL,collection text NOT NULL,revision bigint NOT NULL,
 id uuid NOT NULL REFERENCES jmap_objects(id) ON DELETE CASCADE,
 operation text NOT NULL CHECK(operation IN ('created','updated','destroyed')),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,generation,collection,revision),
 FOREIGN KEY(account_id,generation,collection) REFERENCES jmap_collection_states(account_id,generation,collection) ON DELETE CASCADE
);
CREATE INDEX jmap_collection_changes_expiry ON jmap_collection_changes(account_id,generation,collection,occurred_at);
CREATE TABLE jmap_dirty_accounts(account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE);
CREATE FUNCTION hail_jmap_refresh(owner uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE gen bigint; c text; row record; ident uuid; rev bigint; op text;
BEGIN
 SELECT generation INTO gen FROM account_serving_generations WHERE account_id=owner;
 IF gen IS NULL THEN RETURN; END IF;
 -- Explicit and deferred refreshes acquire the same lock order.
 INSERT INTO jmap_dirty_accounts VALUES(owner) ON CONFLICT(account_id) DO UPDATE SET account_id=EXCLUDED.account_id;
 FOREACH c IN ARRAY ARRAY['HailSent','HailSubmission','HailGrant','HailRelationship'] LOOP
  INSERT INTO jmap_collection_states(account_id,generation,collection) VALUES(owner,gen,c) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM jmap_collection_states WHERE account_id=owner AND generation=gen AND collection=c FOR UPDATE;
  FOR row IN
   SELECT live.key,live.data,stored.id AS old_id,stored.data AS old_data
   FROM (SELECT * FROM jmap_live_objects WHERE account_id=owner AND collection=c) live
   FULL JOIN (SELECT * FROM jmap_objects WHERE account_id=owner AND generation=gen AND collection=c AND NOT destroyed) stored USING(key)
   WHERE live.data IS DISTINCT FROM stored.data ORDER BY COALESCE(live.key,stored.key)
  LOOP
   IF row.key IS NULL THEN
    ident:=row.old_id;op:='destroyed';UPDATE jmap_objects SET destroyed=true WHERE id=ident;
   ELSIF row.old_id IS NULL THEN
    op:='created';INSERT INTO jmap_objects(account_id,generation,collection,key,data)
     VALUES(owner,gen,c,row.key,row.data) RETURNING id INTO ident;
   ELSE
    ident:=row.old_id;op:='updated';UPDATE jmap_objects SET data=row.data WHERE id=ident;
   END IF;
   UPDATE jmap_collection_states SET revision=revision+1 WHERE account_id=owner AND generation=gen AND collection=c RETURNING revision INTO rev;
   INSERT INTO jmap_collection_changes(account_id,generation,collection,revision,id,operation) VALUES(owner,gen,c,rev,ident,op);
  END LOOP;
 END LOOP;
 DELETE FROM jmap_dirty_accounts WHERE account_id=owner;
END $$;
CREATE FUNCTION hail_jmap_flush_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM jmap_dirty_accounts WHERE account_id=NEW.account_id) THEN PERFORM hail_jmap_refresh(NEW.account_id); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jmap_flush_dirty AFTER INSERT ON jmap_dirty_accounts DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION hail_jmap_flush_dirty();
CREATE FUNCTION hail_jmap_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; owner uuid; selected_grant uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN item:=to_jsonb(OLD);ELSE item:=to_jsonb(NEW);END IF;
 IF TG_ARGV[0]='grant' THEN
  selected_grant:=(item->>'grant_id')::uuid;
  FOR owner IN SELECT local_account_id FROM grant_lineages l WHERE l.grant_id=selected_grant UNION
    SELECT grantee_account_id FROM collocated_grant_receivers c WHERE c.grant_id=selected_grant ORDER BY 1 LOOP
   INSERT INTO jmap_dirty_accounts VALUES(owner) ON CONFLICT DO NOTHING;
  END LOOP;
 ELSIF TG_ARGV[0]='did' THEN
  SELECT id INTO owner FROM provider_accounts WHERE did=item->>'sender_did';
  IF owner IS NOT NULL THEN INSERT INTO jmap_dirty_accounts VALUES(owner) ON CONFLICT DO NOTHING;END IF;
 ELSE
  owner:=(item->>TG_ARGV[0])::uuid;
  IF owner IS NOT NULL AND EXISTS(SELECT 1 FROM provider_accounts WHERE id=owner) THEN INSERT INTO jmap_dirty_accounts VALUES(owner) ON CONFLICT DO NOTHING;END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['account_publications','publication_targets','connection_message_batches','connection_message_targets','account_sent_dispositions','federated_connection_pairs','account_serving_generations','connection_unseen','connection_invitations','federated_connection_attempts','account_conversation_preferences','connection_conversation_preferences','conversation_memberships'] LOOP
  EXECUTE format('CREATE TRIGGER jmap_dirty AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hail_jmap_dirty(''account_id'')',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['sent_envelopes','detached_bodies'] LOOP
  EXECUTE format('CREATE TRIGGER jmap_dirty AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hail_jmap_dirty(''sender_account_id'')',t);
 END LOOP;
END $$;
CREATE TRIGGER jmap_dirty AFTER INSERT OR UPDATE OR DELETE ON sent_delivery_status FOR EACH ROW EXECUTE FUNCTION hail_jmap_dirty('did');
CREATE TRIGGER jmap_dirty AFTER INSERT OR UPDATE OR DELETE ON grant_lineages FOR EACH ROW EXECUTE FUNCTION hail_jmap_dirty('local_account_id');
CREATE TRIGGER jmap_dirty_receivers AFTER INSERT OR UPDATE OR DELETE ON grant_lineages FOR EACH ROW EXECUTE FUNCTION hail_jmap_dirty('grant');
CREATE TRIGGER jmap_dirty AFTER INSERT OR UPDATE OR DELETE ON grant_revisions FOR EACH ROW EXECUTE FUNCTION hail_jmap_dirty('grant');
CREATE TRIGGER jmap_dirty AFTER INSERT OR UPDATE OR DELETE ON collocated_grant_receivers FOR EACH ROW EXECUTE FUNCTION hail_jmap_dirty('grantee_account_id');
INSERT INTO jmap_dirty_accounts SELECT account_id FROM account_serving_generations;
