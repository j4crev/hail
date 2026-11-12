package hailcodec

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"regexp"
)

var assetIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func pngDimensions(data []byte) (int64, int64, error) {
	signature := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	if len(data) < 45 || !bytes.Equal(data[:8], signature) {
		return 0, 0, errors.New("asset data must be a PNG image")
	}
	offset, width, height := 8, int64(0), int64(0)
	header, imageData, endChunk, palette, dataEnded := false, false, false, false, false
	colorType := byte(255)
	for offset+12 <= len(data) {
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		end := offset + 12 + length
		if length < 0 || end < offset || end > len(data) {
			return 0, 0, errors.New("asset data contains a truncated PNG chunk")
		}
		chunkType := string(data[offset+4 : offset+8])
		if binary.BigEndian.Uint32(data[offset+8+length:end]) != crc32.ChecksumIEEE(data[offset+4:offset+8+length]) {
			return 0, 0, errors.New("asset PNG has invalid chunk CRC")
		}
		if !header && chunkType != "IHDR" {
			return 0, 0, errors.New("asset PNG must begin with IHDR")
		}
		switch chunkType {
		case "IHDR":
			if header || length != 13 {
				return 0, 0, errors.New("asset PNG has invalid IHDR")
			}
			header = true
			width = int64(binary.BigEndian.Uint32(data[offset+8 : offset+12]))
			height = int64(binary.BigEndian.Uint32(data[offset+12 : offset+16]))
			depth, color := data[offset+16], data[offset+17]
			valid := map[byte]map[byte]bool{0: {1: true, 2: true, 4: true, 8: true, 16: true}, 2: {8: true, 16: true}, 3: {1: true, 2: true, 4: true, 8: true}, 4: {8: true, 16: true}, 6: {8: true, 16: true}}
			if !valid[color][depth] || data[offset+18] != 0 || data[offset+19] != 0 || data[offset+20] > 1 {
				return 0, 0, errors.New("asset PNG has invalid IHDR profile")
			}
			colorType = color
		case "acTL":
			return 0, 0, errors.New("animated PNG is unsupported")
		case "PLTE":
			if imageData || palette || length == 0 || length%3 != 0 || length > 768 {
				return 0, 0, errors.New("asset PNG has invalid palette")
			}
			palette = true
		case "IDAT":
			if dataEnded {
				return 0, 0, errors.New("asset PNG has nonconsecutive image data")
			}
			imageData = true
		case "IEND":
			if length != 0 || end != len(data) {
				return 0, 0, errors.New("asset PNG has invalid IEND")
			}
			endChunk = true
		default:
			if imageData {
				dataEnded = true
			}
			if data[offset+4] >= 'A' && data[offset+4] <= 'Z' {
				return 0, 0, errors.New("asset PNG has unsupported critical chunk")
			}
		}
		offset = end
		if endChunk {
			break
		}
	}
	if !header || !imageData || !endChunk || width == 0 || height == 0 || colorType == 3 && !palette || (colorType == 0 || colorType == 4) && palette {
		return 0, 0, errors.New("asset data must be a complete PNG image")
	}
	return width, height, nil
}

// jpegDimensions performs bounded container and header checks for a baseline or
// progressive 8-bit JPEG and returns the frame size. Pixels are never decoded.
func jpegDimensions(data []byte) (int64, int64, error) {
	invalid := errors.New("asset data must be a complete baseline or progressive JPEG image")
	if len(data) < 4 || data[0] != 0xff || data[1] != 0xd8 {
		return 0, 0, invalid
	}
	u16 := func(at int) int { return int(data[at])<<8 | int(data[at+1]) }
	offset, inScan, sawScan, sawData := 2, false, false, false
	var width, height int64
	var components map[byte]bool
	for offset < len(data) {
		if inScan && data[offset] != 0xff {
			sawData = true
			offset++
			continue
		}
		if data[offset] != 0xff {
			return 0, 0, invalid
		}
		offset++
		for offset < len(data) && data[offset] == 0xff {
			offset++
		}
		if offset >= len(data) {
			return 0, 0, invalid
		}
		marker := data[offset]
		offset++
		if inScan && (marker == 0 || marker >= 0xd0 && marker <= 0xd7) {
			if marker == 0 {
				sawData = true
			}
			continue
		}
		inScan = false
		if marker == 0xd9 {
			if components == nil || !sawScan || !sawData || offset != len(data) {
				return 0, 0, invalid
			}
			return width, height, nil
		}
		switch {
		case marker == 0xc0, marker == 0xc1, marker == 0xc2, marker == 0xc4, marker == 0xdb, marker == 0xdd, marker == 0xda, marker == 0xfe:
		case marker >= 0xe0 && marker <= 0xef:
		default:
			return 0, 0, invalid
		}
		if offset+2 > len(data) {
			return 0, 0, invalid
		}
		length, start := u16(offset), offset+2
		end := offset + length
		if length < 2 || end > len(data) {
			return 0, 0, invalid
		}
		switch marker {
		case 0xc0, 0xc1, 0xc2:
			if components != nil || length < 11 || data[start] != 8 {
				return 0, 0, invalid
			}
			height, width = int64(u16(start+1)), int64(u16(start+3))
			count := int(data[start+5])
			if width == 0 || height == 0 || count < 1 || count > 4 || length != 8+3*count {
				return 0, 0, invalid
			}
			components = map[byte]bool{}
			for index := 0; index < count; index++ {
				id, sampling := data[start+6+3*index], data[start+7+3*index]
				if components[id] || sampling>>4 < 1 || sampling>>4 > 4 || sampling&15 < 1 || sampling&15 > 4 || data[start+8+3*index] > 3 {
					return 0, 0, invalid
				}
				components[id] = true
			}
		case 0xda:
			if components == nil || length < 8 {
				return 0, 0, invalid
			}
			count := int(data[start])
			if count < 1 || count > len(components) || length != 6+2*count {
				return 0, 0, invalid
			}
			selected := map[byte]bool{}
			for index := 0; index < count; index++ {
				id, tables := data[start+1+2*index], data[start+2+2*index]
				if !components[id] || selected[id] || tables>>4 > 3 || tables&15 > 3 {
					return 0, 0, invalid
				}
				selected[id] = true
			}
			if data[end-3] > 63 || data[end-2] > 63 {
				return 0, 0, invalid
			}
			sawScan, inScan = true, true
		case 0xdd:
			if length != 4 {
				return 0, 0, invalid
			}
		}
		offset = end
	}
	return 0, 0, invalid
}

// Bundled-image limits from spec/assets.md and spec/bodies.md.
const (
	MaximumBundledAssets = 24
	MaximumImageBlocks   = 24
	MaximumBodyPixels    = 8000000
	MaximumMessageImage  = 524288
	MaximumAvatarImage   = 32768
	maximumMessagePixels = 2000000
	maximumMessageSide   = 2400
	maximumHeaderHeight  = 1200
	maximumAvatarSide    = 512
	maximumAvatarPixels  = 262144
)

func ValidateAssetManifest(manifest *AssetManifest) error {
	if manifest == nil || manifest.Version != 1 || len(manifest.Assets) < 1 || len(manifest.Assets) > MaximumBundledAssets {
		return errors.New("invalid asset manifest header or count")
	}
	ids, roles := map[string]bool{}, map[string]bool{}
	for index, asset := range manifest.Assets {
		path := fmt.Sprintf("assets[%d]", index)
		if !assetIDPattern.MatchString(asset.ID) || ids[asset.ID] {
			return fmt.Errorf("%s has invalid or duplicate id", path)
		}
		if asset.Role != "avatar" && asset.Role != "header" && asset.Role != "image" || asset.Role != "image" && roles[asset.Role] {
			return fmt.Errorf("%s has invalid or duplicate role", path)
		}
		ids[asset.ID], roles[asset.Role] = true, true
		// Profile avatars are PNG only; message images may also be JPEG.
		jpeg := asset.MediaType == "image/jpeg" && asset.Role != "avatar"
		if asset.MediaType != "image/png" && !jpeg || asset.Loading != "bundled" {
			return fmt.Errorf("%s uses an unsupported image profile", path)
		}
		maxBytes, maxWidth, maxHeight, maxPixels := int64(MaximumMessageImage), int64(maximumMessageSide), int64(maximumHeaderHeight), int64(maximumMessagePixels)
		if asset.Role == "image" {
			maxHeight = maximumMessageSide
		}
		if asset.Role == "avatar" {
			maxBytes, maxWidth, maxHeight, maxPixels = MaximumAvatarImage, maximumAvatarSide, maximumAvatarSide, maximumAvatarPixels
		}
		if asset.Size != int64(len(asset.Data)) || asset.Size < 1 || asset.Size > maxBytes || asset.Digest.Algorithm != "sha-256" || len(asset.Digest.Value) != 32 {
			return fmt.Errorf("%s has invalid size or digest", path)
		}
		digest := sha256.Sum256(asset.Data)
		if !bytes.Equal(digest[:], asset.Digest.Value) {
			return fmt.Errorf("%s digest does not match data", path)
		}
		// The declared type selects the validator; bytes of another format fail it.
		dimensions := pngDimensions
		if jpeg {
			dimensions = jpegDimensions
		}
		width, height, err := dimensions(asset.Data)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		if asset.Width != width || asset.Height != height || width > maxWidth || height > maxHeight || width*height > maxPixels {
			return fmt.Errorf("%s has invalid image dimensions", path)
		}
	}
	return nil
}
