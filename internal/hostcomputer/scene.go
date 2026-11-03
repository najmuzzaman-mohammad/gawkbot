package hostcomputer

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// A Scene is what the app draws over the person's screen: pointers,
// labels, arrows, circles and boxes, in global screen points with the
// origin at the top-left of the main display (the space the driver
// reports element frames in). It is drawn by desktop/oswails/overlay_darwin.m
// and fades after TTL. WIRE CONTRACT with web/src/notch/types.ts
// (OverlayScene) and the Objective-C reader; change all three together.
type Scene struct {
	ID    string      `json:"id,omitempty"`
	TTLMs int         `json:"ttl_ms,omitempty"`
	Color string      `json:"color,omitempty"`
	Items []SceneItem `json:"items"`
}

// SceneItem is one drawing. Kind decides which fields matter.
type SceneItem struct {
	Kind  string  `json:"kind"`
	X     float64 `json:"x,omitempty"`
	Y     float64 `json:"y,omitempty"`
	Text  string  `json:"text,omitempty"`
	Label string  `json:"label,omitempty"`
	Color string  `json:"color,omitempty"`
	From  *Rect   `json:"from,omitempty"`
	To    *Rect   `json:"to,omitempty"`
	Rect  *Rect   `json:"rect,omitempty"`
}

// Rect is a box in screen points, top-left origin.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Center is the middle of the rect.
func (r Rect) Center() (float64, float64) { return r.X + r.W/2, r.Y + r.H/2 }

// Scene limits: a drawing is a hint, not a poster.
const (
	SceneMaxItems  = 24
	SceneMaxTTLMs  = 60_000
	SceneTextMax   = 80
	sceneCoordMax  = 32_000
	defaultSceneMs = 6_000
)

var sceneKinds = map[string]bool{"pointer": true, "label": true, "arrow": true, "circle": true, "box": true}

// ValidateScene bounds a scene before it reaches the screen: known kinds,
// sane coordinates, short text, a capped lifetime. It fills the default
// lifetime when none is given.
func ValidateScene(s *Scene) error {
	if s == nil {
		return errors.New("no scene")
	}
	if len(s.Items) == 0 {
		return errors.New("a scene needs at least one item")
	}
	if len(s.Items) > SceneMaxItems {
		return fmt.Errorf("a scene may hold at most %d items", SceneMaxItems)
	}
	if s.TTLMs < 0 || s.TTLMs > SceneMaxTTLMs {
		return fmt.Errorf("ttl_ms must be between 0 and %d", SceneMaxTTLMs)
	}
	if s.TTLMs == 0 {
		s.TTLMs = defaultSceneMs
	}
	if !validHex(s.Color) {
		return errors.New("color must be #rrggbb")
	}
	for i := range s.Items {
		it := &s.Items[i]
		if !sceneKinds[it.Kind] {
			return fmt.Errorf("item %d: unknown kind %q", i, it.Kind)
		}
		if !validHex(it.Color) {
			return fmt.Errorf("item %d: color must be #rrggbb", i)
		}
		it.Label = sceneText(it.Label)
		it.Text = sceneText(it.Text)
		switch it.Kind {
		case "pointer", "label":
			if !validCoord(it.X) || !validCoord(it.Y) {
				return fmt.Errorf("item %d: x and y must be on screen", i)
			}
			if it.Kind == "label" && it.Text == "" {
				return fmt.Errorf("item %d: a label needs text", i)
			}
		case "arrow":
			if it.From == nil || it.To == nil || !validRect(*it.From) || !validRect(*it.To) {
				return fmt.Errorf("item %d: an arrow needs from and to", i)
			}
		case "circle", "box":
			if it.Rect == nil || !validRect(*it.Rect) {
				return fmt.Errorf("item %d: a %s needs a rect", i, it.Kind)
			}
		}
	}
	return nil
}

func validHex(s string) bool {
	if s == "" {
		return true
	}
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	for _, r := range s[1:] {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return false
		}
	}
	return true
}

func validCoord(v float64) bool { return v >= -sceneCoordMax && v <= sceneCoordMax }

func validRect(r Rect) bool {
	return validCoord(r.X) && validCoord(r.Y) && r.W >= 0 && r.H >= 0 && r.W <= sceneCoordMax && r.H <= sceneCoordMax
}

// sceneText keeps a drawing's words short and printable: control
// characters out, one line, capped.
func sceneText(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		if r == '\n' || r == '\t' {
			r = ' '
		}
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	if utf8.RuneCountInString(out) > SceneTextMax {
		runes := []rune(out)
		out = string(runes[:SceneTextMax-1]) + "…"
	}
	return out
}

// JSON renders the scene for the native reader.
func (s Scene) JSON() string {
	raw, _ := json.Marshal(s)
	return string(raw)
}

// PointerScene is the common case: one pointer at an element with a word
// or two beside it.
func PointerScene(x, y float64, label string, ttlMs int) Scene {
	return Scene{ID: "point", TTLMs: ttlMs, Items: []SceneItem{{Kind: "pointer", X: x, Y: y, Label: label}}}
}
