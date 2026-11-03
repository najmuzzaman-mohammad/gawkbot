package dataspace

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Prefixes for the ids this store mints. Ids are opaque strings everywhere;
// nothing parses them apart from the prefix check on a space id.
const (
	prefixSpace     = "space"
	prefixType      = "type"
	prefixAttribute = "attr"
	prefixOption    = "opt"
	prefixRecord    = "rec"
	prefixRelation  = "rel"
	prefixToken     = "del"
)

// idHexLen is the number of hex characters after the prefix, matching the
// app_<16hex> shape used elsewhere in the repo.
const idHexLen = 16

// newID mints "<prefix>_<16 hex>" from crypto/rand.
//
// Random rather than sha256 over name+createdAt the way custom_app.go derives
// an app id: two spaces created by the same bot with the same name inside one
// clock tick would derive the same id, and a derived id also encodes the name
// and the owner into something that gets logged and put in URLs. Random ids
// have neither problem, and the caller checks for a collision before insert.
func newID(prefix string) string {
	var buf [idHexLen / 2]byte
	// crypto/rand.Read never reports an error; it panics internally instead.
	_, _ = rand.Read(buf[:])
	return prefix + "_" + hex.EncodeToString(buf[:])
}

// IsSpaceID reports whether s has the shape this store mints for a space id.
// Exported so the broker and the MCP tools can reject a malformed id before
// they ever reach the store.
func IsSpaceID(s string) bool {
	if !strings.HasPrefix(s, prefixSpace+"_") {
		return false
	}
	rest := strings.TrimPrefix(s, prefixSpace+"_")
	if len(rest) != idHexLen {
		return false
	}
	for _, r := range rest {
		if !((r >= 'a' && r <= 'f') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// isAppID reports whether s looks like the app_<16hex> ids custom_app.go mints.
func isAppID(s string) bool {
	if !strings.HasPrefix(s, "app_") {
		return false
	}
	rest := strings.TrimPrefix(s, "app_")
	if len(rest) != idHexLen {
		return false
	}
	for _, r := range rest {
		if !((r >= 'a' && r <= 'f') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// slugify lowercases, keeps [a-z0-9], collapses every other run to a single
// underscore, trims underscores, and falls back when nothing is left. Matching
// slugify() in web/src/api/dataspaces.mock.store.ts exactly, including the
// guarantee that a slug can never start with "_" and so never collides with a
// system field.
func slugify(name, fallback string) string {
	lowered := strings.ToLower(name)
	var b strings.Builder
	b.Grow(len(lowered))
	pendingGap := false
	for _, r := range lowered {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			// A gap before the first kept character would be a leading
			// underscore, which no slug may have.
			if pendingGap && b.Len() > 0 {
				b.WriteByte('_')
			}
			pendingGap = false
			b.WriteRune(r)
			continue
		}
		pendingGap = true
	}
	slug := b.String()
	if slug == "" {
		return fallback
	}
	return slug
}

// uniqueSlug appends _2, _3 … until the slug is free.
func uniqueSlug(base string, taken map[string]bool) string {
	if !taken[base] {
		return base
	}
	for suffix := 2; ; suffix++ {
		candidate := base + "_" + strconv.Itoa(suffix)
		if !taken[candidate] {
			return candidate
		}
	}
}

// sameName is the case- and whitespace-insensitive name comparison used for
// every duplicate check in this package.
func sameName(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

// cleanName trims a required display name, or explains what is missing.
func cleanName(raw, what string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", &ValidationError{Message: what + " needs a name."}
	}
	return name, nil
}

// normalizeActor lowercases and trims an actor slug.
func normalizeActor(actor Actor) string {
	return strings.ToLower(strings.TrimSpace(string(actor)))
}

// show renders a rejected input the way the TypeScript mock's show() does:
// a string in double quotes, anything else as JSON.
func show(raw any) string {
	if s, ok := raw.(string); ok {
		return `"` + s + `"`
	}
	if f, ok := asFloat(raw); ok {
		if math.IsNaN(f) || math.IsInf(f, 0) {
			// JSON.stringify(NaN) is "null"; keep the same wording.
			return "null"
		}
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return fmt.Sprintf("%v", raw)
	}
	return string(encoded)
}

// asFloat unwraps the numeric shapes a JSON decoder or a Go caller can hand in.
func asFloat(raw any) (float64, bool) {
	switch v := raw.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int32:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

// valueString renders a stored Value as the text a person sees in the cell:
// what String(value) produces in the mock, and what unique keys are built from.
func valueString(value Value) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case []string:
		return strings.Join(v, ",")
	default:
		if f, ok := asFloat(value); ok {
			return strconv.FormatFloat(f, 'f', -1, 64)
		}
		return fmt.Sprintf("%v", value)
	}
}

// uniqueKey is the case-insensitive key a unique attribute is indexed by.
func uniqueKey(value Value) string {
	return strings.ToLower(strings.TrimSpace(valueString(value)))
}

// sortedCopy returns a sorted, duplicate-free copy of ids, so a delete token
// binds to a set rather than to an order.
func sortedCopy(ids []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
