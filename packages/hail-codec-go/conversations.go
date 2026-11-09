package hailcodec

import (
	"bytes"
	"crypto/sha256"
	"errors"
)

// Conversation is a fixed roster proposal, not a delivery capability.
type Conversation struct {
	Type               string   `cbor:"type"`
	Version            int64    `cbor:"version"`
	ConversationID     string   `cbor:"conversation_id"`
	From               string   `cbor:"from"`
	MembershipRevision int64    `cbor:"membership_revision"`
	Participants       []string `cbor:"participants"`
	CreatedAt          int64    `cbor:"created_at"`
	AdmissionUntil     int64    `cbor:"admission_until"`
}

func (Conversation) PayloadType() string { return ConversationType }

type ConversationIntroduction struct {
	Descriptor   []byte `cbor:"descriptor"`
	ConnectionID string `cbor:"connection_id"`
	Epoch        int64  `cbor:"epoch"`
}

func validateConversationEnvelope(m, a map[any]any) error {
	if e := exact(a, []string{"type", "creator", "conversation_id", "membership_revision", "descriptor_hash"}, nil, "$.authorization"); e != nil {
		return e
	}
	if _, e := did(a["creator"], "$.authorization.creator"); e != nil {
		return e
	}
	if e := uuid(a["conversation_id"], "$.authorization.conversation_id"); e != nil {
		return e
	}
	if revision, e := intValue(a["membership_revision"], "$.authorization.membership_revision", 1); e != nil || revision != 1 {
		return errors.New("fixed roster requires revision 1")
	}
	if e := digest(a["descriptor_hash"], "$.authorization.descriptor_hash"); e != nil {
		return e
	}
	if e := uuid(m["conversation_message_id"], "$.conversation_message_id"); e != nil {
		return e
	}
	if m["from"] == m["to"] {
		return errors.New("distinct conversation participants required")
	}
	if has(m, "conversation_introduction") {
		i, e := mapValue(m["conversation_introduction"], "$.conversation_introduction")
		if e != nil {
			return e
		}
		if e = exact(i, []string{"descriptor", "connection_id", "epoch"}, nil, "$.conversation_introduction"); e != nil {
			return e
		}
		if e = uuid(i["connection_id"], "$.conversation_introduction.connection_id"); e != nil {
			return e
		}
		if _, e = intValue(i["epoch"], "$.conversation_introduction.epoch", 1); e != nil {
			return e
		}
		b, ok := i["descriptor"].([]byte)
		if !ok || len(b) < 1 || len(b) > 16384 {
			return errors.New("invalid signed descriptor bytes")
		}
		if m["from"] != a["creator"] || has(m, "in_reply_to") || m["conversation_message_id"] != a["conversation_id"] {
			return errors.New("only creator can introduce the root message")
		}
		d, _ := mapValue(a["descriptor_hash"], "$.authorization.descriptor_hash")
		hash := sha256.Sum256(b)
		if !bytes.Equal(hash[:], d["value"].([]byte)) {
			return errors.New("descriptor hash mismatch")
		}
	}
	if has(m, "in_reply_to") {
		p, e := mapValue(m["in_reply_to"], "$.in_reply_to")
		if e != nil {
			return e
		}
		if e = exact(p, []string{"sender", "message_id"}, nil, "$.in_reply_to"); e != nil {
			return e
		}
		if _, e = did(p["sender"], "$.in_reply_to.sender"); e != nil {
			return e
		}
		if e = uuid(p["message_id"], "$.in_reply_to.message_id"); e != nil {
			return e
		}
		if p["sender"] == m["from"] && p["message_id"] == m["conversation_message_id"] {
			return errors.New("conversation message cannot reply to itself")
		}
	}
	r, e := mapValue(m["reply"], "$.reply")
	if e != nil {
		return e
	}
	if r["allowed"] != false {
		return errors.New("conversation cannot issue independent replies")
	}
	return nil
}

func conversationValue(v *Conversation) map[any]any {
	members := make([]any, len(v.Participants))
	for i, member := range v.Participants {
		members[i] = member
	}
	return map[any]any{"type": v.Type, "version": v.Version, "conversation_id": v.ConversationID, "from": v.From,
		"membership_revision": v.MembershipRevision, "participants": members, "created_at": v.CreatedAt, "admission_until": v.AdmissionUntil}
}
func validateConversation(m map[any]any) error {
	if e := exact(m, []string{"type", "version", "conversation_id", "from", "membership_revision", "participants", "created_at", "admission_until"}, nil, "$"); e != nil {
		return e
	}
	if e := uuid(m["conversation_id"], "$.conversation_id"); e != nil {
		return e
	}
	creator, e := did(m["from"], "$.from")
	if e != nil {
		return e
	}
	revision, e := intValue(m["membership_revision"], "$.membership_revision", 1)
	if e != nil || revision != 1 {
		return errors.New("fixed roster requires revision 1")
	}
	members, ok := m["participants"].([]any)
	if !ok || len(members) < 3 || len(members) > 101 {
		return errors.New("requires 3 to 101 participants")
	}
	previous := ""
	includesCreator := false
	for _, member := range members {
		current, e := did(member, "$.participants")
		if e != nil {
			return e
		}
		if current <= previous {
			return errors.New("participants must be unique and sorted by DID")
		}
		previous = current
		includesCreator = includesCreator || current == creator
	}
	if !includesCreator {
		return errors.New("creator must be a participant")
	}
	return conversationWindow(m, "created_at", "admission_until", 604800)
}
func conversationWindow(m map[any]any, start, end string, maximum int64) error {
	issued, e := intValue(m[start], "$."+start, 0)
	if e != nil {
		return e
	}
	expires, e := intValue(m[end], "$."+end, 0)
	if e != nil {
		return e
	}
	if expires <= issued || expires-issued > maximum {
		return errors.New("invalid conversation request validity window")
	}
	return nil
}
