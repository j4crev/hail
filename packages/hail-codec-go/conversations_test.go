package hailcodec

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestConversationVectors(t *testing.T) {
	raw, err := os.ReadFile("../hail-codec-ts/vectors/conversations-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors manifest
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	key := vectors.TestKeys[0]
	privateKey := ed25519.NewKeyFromSeed(fromHex(t, key.SeedHex))
	verifier := VerifierFunc(func(kid string, data, sig []byte) bool {
		return kid == key.KeyID && ed25519.Verify(fromHex(t, key.PublicKeyHex), data, sig)
	})
	verified := map[string]*VerifiedObject{}
	for _, v := range vectors.Positive {
		t.Run(v.ID, func(t *testing.T) {
			payload, err := DecodePayload(v.Type, fromHex(t, v.PayloadHex))
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := EncodePayload(payload)
			if err != nil || !bytes.Equal(encoded, fromHex(t, v.PayloadHex)) {
				t.Fatalf("roundtrip: %v", err)
			}
			digest := sha256.Sum256(encoded)
			if hex.EncodeToString(digest[:]) != v.PayloadSHA256Hex {
				t.Fatal("payload digest mismatch")
			}
			signed, err := SignPayload(payload, privateKey)
			if err != nil || !bytes.Equal(signed, fromHex(t, v.COSEHex)) {
				t.Fatalf("signature: %v", err)
			}
			digest = sha256.Sum256(signed)
			if hex.EncodeToString(digest[:]) != v.RepresentationSHA256Hex {
				t.Fatal("representation digest mismatch")
			}
			result, err := VerifySignedPayload(v.Type, signed, verifier)
			if err != nil {
				t.Fatal(err)
			}
			verified[v.ID] = result
			if _, err = InspectSignedPayload(EnvelopeType, signed); v.Type != EnvelopeType && err == nil {
				t.Fatal("conversation accepted as envelope")
			}
			signed[len(signed)-1] ^= 1
			if _, err = VerifySignedPayload(v.Type, signed, verifier); err == nil {
				t.Fatal("corrupt signature accepted")
			}
			switch detached := result.Payload().(type) {
			case *Conversation:
				detached.Participants[0] = "changed"
				if result.Payload().(*Conversation).Participants[0] == "changed" {
					t.Fatal("roster aliases verified object")
				}
			}
		})
	}
	for _, v := range vectors.NegativePayload {
		t.Run(v.ID, func(t *testing.T) {
			if _, err := DecodePayload(v.Type, fromHex(t, v.Hex)); err == nil {
				t.Fatal("invalid conversation accepted")
			}
		})
	}
}
