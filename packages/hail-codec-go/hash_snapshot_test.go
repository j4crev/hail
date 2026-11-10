package hailcodec

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"fmt"
	"github.com/fxamacker/cbor/v2"
)

// Independent consumer of the reference snapshot's externally carried preimage.
func verifySnapshotHash(wire, preimage, key []byte, kind, kid string) bool {
	if len(wire) > 1024 || len(preimage) > 67108864 {
		return false
	}
	dec, _ := (cbor.DecOptions{DupMapKey: cbor.DupMapKeyEnforcedAPF, IndefLength: cbor.IndefLengthForbidden, MaxNestedLevels: 8, MaxArrayElements: 16, MaxMapPairs: 16, IntDec: cbor.IntDecConvertSignedOrFail}).DecMode()
	enc, _ := cbor.CanonicalEncOptions().EncMode()
	var tag cbor.RawTag
	if dec.Unmarshal(wire, &tag) != nil || tag.Number != 18 {
		return false
	}
	var a []any
	if dec.Unmarshal(tag.Content, &a) != nil || len(a) != 4 {
		return false
	}
	canonical, _ := enc.Marshal(cbor.Tag{Number: 18, Content: a})
	if !bytes.Equal(canonical, wire) {
		return false
	}
	p, ok := a[0].([]byte)
	if !ok {
		return false
	}
	u, ok := a[1].(map[any]any)
	if !ok || len(u) != 0 {
		return false
	}
	d, ok := a[2].([]byte)
	if !ok || len(d) != 32 {
		return false
	}
	sig, ok := a[3].([]byte)
	if !ok || len(sig) != 64 {
		return false
	}
	var h map[any]any
	if dec.Unmarshal(p, &h) != nil {
		return false
	}
	canonical, _ = enc.Marshal(h)
	if !bytes.Equal(canonical, p) {
		return false
	}
	version := 7
	if kind == "managed" {
		version = 8
	}
	expected := fmt.Sprintf("application/hail-%s-snapshot+json;version=%d", kind, version)
	k, ok := h[int64(4)].([]byte)
	if !ok || string(k) != kid || len(h) != 4 || h[int64(1)] != int64(-19) || h[int64(258)] != int64(-16) || h[int64(259)] != expected {
		return false
	}
	digest := sha256.Sum256(preimage)
	if !bytes.Equal(d, digest[:]) {
		return false
	}
	input, _ := enc.Marshal([]any{"Signature1", p, []byte{}, d})
	return ed25519.Verify(key, input, sig)
}
