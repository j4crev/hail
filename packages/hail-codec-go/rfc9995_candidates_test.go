package hailcodec

// Experimental independent consumer: no TypeScript/server code and no changes
// to production codec acceptance. Standard-library Ed25519 + independent CBOR.
import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

const candidateAdmission = "https://haili.app/ns/racr/experimental-admission"
const candidatePreimage = "https://haili.app/ns/racr/experimental-preimage"

type hashCandidate struct{ ID, Kind, Kid, PreimageHex, WireHex, SignatureInputHex string }

func verifyHashCandidate(v hashCandidate, wire, publicKey []byte) ([]byte, error) {
	limit := 17408
	if v.Kind == "portable" || v.Kind == "managed" {
		limit = 67109888
	}
	if len(wire) > limit {
		return nil, fmt.Errorf("candidate size")
	}
	dec, err := (cbor.DecOptions{DupMapKey: cbor.DupMapKeyEnforcedAPF, IndefLength: cbor.IndefLengthForbidden, MaxNestedLevels: 8, MaxArrayElements: 16, MaxMapPairs: 16, IntDec: cbor.IntDecConvertSignedOrFail}).DecMode()
	if err != nil {
		return nil, err
	}
	enc, _ := cbor.CanonicalEncOptions().EncMode()
	var tagged cbor.RawTag
	if err = dec.Unmarshal(wire, &tagged); err != nil || tagged.Number != 18 {
		return nil, fmt.Errorf("candidate tag: %v", err)
	}
	var parts []any
	if err = dec.Unmarshal(tagged.Content, &parts); err != nil || len(parts) != 4 {
		return nil, fmt.Errorf("candidate array")
	}
	canonical, _ := enc.Marshal(cbor.Tag{Number: 18, Content: parts})
	if !bytes.Equal(wire, canonical) {
		return nil, fmt.Errorf("noncanonical carrier")
	}
	p, ok := parts[0].([]byte)
	if !ok {
		return nil, fmt.Errorf("protected bytes")
	}
	protectedLimit := 1024
	if v.Kind == "body" {
		protectedLimit = 16384
	}
	if len(p) > protectedLimit {
		return nil, fmt.Errorf("protected size")
	}
	u, ok := parts[1].(map[any]any)
	if !ok {
		return nil, fmt.Errorf("unprotected map")
	}
	d, ok := parts[2].([]byte)
	if !ok || len(d) != 32 {
		return nil, fmt.Errorf("digest")
	}
	s, ok := parts[3].([]byte)
	if !ok || len(s) != 64 {
		return nil, fmt.Errorf("signature")
	}
	var h map[any]any
	if err = dec.Unmarshal(p, &h); err != nil {
		return nil, err
	}
	canonical, _ = enc.Marshal(h)
	if !bytes.Equal(canonical, p) {
		return nil, fmt.Errorf("noncanonical protected")
	}
	ct := "application/hail-envelope+cbor"
	n := 4
	switch v.Kind {
	case "body":
		ct = "application/hail-body+cbor"
		n = 6
	case "portable":
		ct = "application/hail-portable-snapshot+json;version=7"
	case "managed":
		ct = "application/hail-managed-snapshot+json;version=8"
	}
	kid, ok := h[int64(4)].([]byte)
	if !ok || string(kid) != v.Kid || len(h) != n || h[int64(1)] != int64(-19) || h[int64(258)] != int64(-16) || h[int64(259)] != ct {
		return nil, fmt.Errorf("header profile")
	}
	input, _ := enc.Marshal([]any{"Signature1", p, []byte{}, d})
	expected, _ := hex.DecodeString(v.SignatureInputHex)
	if !bytes.Equal(input, expected) || !ed25519.Verify(publicKey, input, s) {
		return nil, fmt.Errorf("signature input/verification")
	}
	var preimage []byte
	if v.Kind == "body" {
		critical, ok := h[int64(2)].([]any)
		if !ok || len(critical) != 1 || critical[0] != candidateAdmission || len(u) != 0 {
			return nil, fmt.Errorf("critical/unprotected")
		}
		metadata, ok := h[candidateAdmission].([]byte)
		if !ok {
			return nil, fmt.Errorf("metadata bytes")
		}
		value, err := DecodeDeterministic(metadata)
		if err != nil {
			return nil, err
		}
		envelope, ok := value.(map[any]any)
		if !ok {
			return nil, fmt.Errorf("metadata map")
		}
		body, ok := envelope["body"].(map[any]any)
		if !ok {
			return nil, fmt.Errorf("body map")
		}
		if _, exists := body["digest"]; exists {
			return nil, fmt.Errorf("duplicate digest")
		}
		body["digest"] = map[any]any{"algorithm": "sha-256", "value": d}
		preimage, err = EncodeDeterministic(envelope)
		if err != nil {
			return nil, err
		}
	} else {
		preimage, ok = u[candidatePreimage].([]byte)
		if !ok || len(u) != 1 {
			return nil, fmt.Errorf("preimage bytes")
		}
		max := 16384
		if v.Kind != "descriptor" {
			max = 67108864
		}
		if len(preimage) > max {
			return nil, fmt.Errorf("preimage size")
		}
		digest := sha256.Sum256(preimage)
		if !bytes.Equal(d, digest[:]) {
			return nil, fmt.Errorf("preimage hash")
		}
	}
	if v.Kind == "body" || v.Kind == "descriptor" {
		if _, err = DecodePayload(EnvelopeType, preimage); err != nil {
			return nil, err
		}
		value, _ := DecodeDeterministic(preimage)
		if value.(map[any]any)["from"].(string)+"#hail-messaging" != v.Kid {
			return nil, fmt.Errorf("sender role")
		}
	} else {
		var m struct {
			DID     string
			Version int
		}
		if err = json.Unmarshal(preimage, &m); err != nil {
			return nil, err
		}
		version := 7
		if v.Kind == "managed" {
			version = 8
		}
		if m.DID+"#hail-messaging" != v.Kid || m.Version != version {
			return nil, fmt.Errorf("snapshot binding")
		}
	}
	return preimage, nil
}
func TestExperimentalRFC9995Candidates(t *testing.T) {
	raw, err := os.ReadFile("../../spec/vectors/experimental-rfc9995.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		PublicKeyHex string
		Records      []hashCandidate
	}
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	publicKey, _ := hex.DecodeString(vectors.PublicKeyHex)
	for _, v := range vectors.Records {
		t.Run(v.ID, func(t *testing.T) {
			wire, _ := hex.DecodeString(v.WireHex)
			expected, _ := hex.DecodeString(v.PreimageHex)
			got, err := verifyHashCandidate(v, wire, publicKey)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, expected) {
				t.Fatal("exact preimage differs")
			}
			if v.Kind == "body" || v.Kind == "descriptor" {
				if _, err := InspectSignedPayload(EnvelopeType, wire); err == nil {
					t.Fatal("experimental envelope accepted by production codec")
				}
			}
			corrupt := bytes.Clone(wire)
			corrupt[len(corrupt)-1] ^= 1
			if _, err = verifyHashCandidate(v, corrupt, publicKey); err == nil {
				t.Fatal("signature tamper accepted")
			}
			if _, err = verifyHashCandidate(v, wire, make([]byte, 32)); err == nil {
				t.Fatal("wrong source key accepted")
			}
			wrong := v
			wrong.Kid += "-other"
			if _, err = verifyHashCandidate(wrong, wire, publicKey); err == nil {
				t.Fatal("wrong role accepted")
			}
			// Mutate the cleartext admission/manifest preimage, not the signature.
			offset := bytes.Index(wire, expected)
			if offset >= 0 {
				corrupt = bytes.Clone(wire)
				corrupt[offset+len(expected)/2] ^= 1
				if _, err = verifyHashCandidate(v, corrupt, publicKey); err == nil {
					t.Fatal("changed preimage accepted")
				}
			}
		})
	}
}
