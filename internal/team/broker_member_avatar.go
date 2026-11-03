package team

import (
	"fmt"
	"regexp"
	"strings"
)

// MemberAvatar is a bot's chosen look: one of the orb bodies and a body
// colour. Both are optional; an unset field falls back to the
// value derived from the slug (web/src/lib/blobAvatar.ts), so bots created
// before avatars were pickable look exactly as they always did.
type MemberAvatar struct {
	Shape string `json:"shape,omitempty"`
	Color string `json:"color,omitempty"`
	// Look is the character on top of the orb: hair, eyes, an accessory.
	// Optional; absent means the orb alone, as before. Clients that do not
	// know a value draw nothing for it.
	Look *MemberLook `json:"look,omitempty"`
}

// MemberLook is what a character wears. WIRE CONTRACT: the ids match HAIR,
// EYES and ACCESSORIES in web/src/lib/orbLook.ts.
type MemberLook struct {
	Hair      string `json:"hair,omitempty"`
	HairColor string `json:"hair_color,omitempty"`
	Eyes      string `json:"eyes,omitempty"`
	Accessory string `json:"accessory,omitempty"`
}

var (
	LookHair        = []string{"none", "tuft", "bob", "mohawk", "curls", "cap"}
	LookEyes        = []string{"default", "glasses", "wink", "sparkle"}
	LookAccessories = []string{"none", "bow", "tie", "headphones", "scarf", "antenna"}
)

func oneOf(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// normalizeMemberLook validates a look. All-empty (or all "none") is nil.
func normalizeMemberLook(l *MemberLook) (*MemberLook, error) {
	if l == nil {
		return nil, nil
	}
	out := MemberLook{
		Hair:      strings.ToLower(strings.TrimSpace(l.Hair)),
		HairColor: strings.ToLower(strings.TrimSpace(l.HairColor)),
		Eyes:      strings.ToLower(strings.TrimSpace(l.Eyes)),
		Accessory: strings.ToLower(strings.TrimSpace(l.Accessory)),
	}
	if out.Hair != "" && !oneOf(LookHair, out.Hair) {
		return nil, fmt.Errorf("hair must be one of %s", strings.Join(LookHair, ", "))
	}
	if out.Eyes != "" && !oneOf(LookEyes, out.Eyes) {
		return nil, fmt.Errorf("eyes must be one of %s", strings.Join(LookEyes, ", "))
	}
	if out.Accessory != "" && !oneOf(LookAccessories, out.Accessory) {
		return nil, fmt.Errorf("accessory must be one of %s", strings.Join(LookAccessories, ", "))
	}
	if out.HairColor != "" && !avatarColorRE.MatchString(out.HairColor) {
		return nil, fmt.Errorf("hair color must be a #rrggbb hex colour")
	}
	if out.Hair == "none" {
		out.Hair = ""
	}
	if out.Eyes == "default" {
		out.Eyes = ""
	}
	if out.Accessory == "none" {
		out.Accessory = ""
	}
	if out.Hair == "" && out.Eyes == "" && out.Accessory == "" {
		return nil, nil
	}
	if out.Hair == "" {
		out.HairColor = ""
	}
	return &out, nil
}

// AvatarShapes are the orb body ids, in the order of AVATAR_SHAPES in
// web/src/lib/blobAvatar.ts. WIRE CONTRACT: the web and iOS renderers map
// these names to their bodies.
var AvatarShapes = []string{"bear", "lemon", "ghost", "cloud", "drop", "stack", "seacow", "flower"}

// legacyAvatarShapes are the ids of the character set before the orbs. A
// bot that chose one keeps a look: each maps onto the orb that stands in
// for it (the same table as LEGACY_AVATAR_SHAPES on the web and on iOS).
var legacyAvatarShapes = map[string]string{
	"block":  "stack",
	"dome":   "bear",
	"drop":   "drop",
	"bean":   "seacow",
	"pill":   "lemon",
	"loaf":   "cloud",
	"shield": "ghost",
	"blob":   "flower",
}

var avatarColorRE = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// normalizeMemberAvatar validates a requested avatar. A nil or all-empty
// avatar returns (nil, nil): "use the derived look".
func normalizeMemberAvatar(a *MemberAvatar) (*MemberAvatar, error) {
	if a == nil {
		return nil, nil
	}
	look, err := normalizeMemberLook(a.Look)
	if err != nil {
		return nil, err
	}
	out := MemberAvatar{
		Shape: strings.ToLower(strings.TrimSpace(a.Shape)),
		Color: strings.ToLower(strings.TrimSpace(a.Color)),
		Look:  look,
	}
	if out.Shape == "" && out.Color == "" && out.Look == nil {
		return nil, nil
	}
	if out.Shape != "" {
		if now, ok := legacyAvatarShapes[out.Shape]; ok {
			out.Shape = now
		}
		known := false
		for _, s := range AvatarShapes {
			if s == out.Shape {
				known = true
				break
			}
		}
		if !known {
			return nil, fmt.Errorf("avatar shape must be one of %s", strings.Join(AvatarShapes, ", "))
		}
	}
	if out.Color != "" && !avatarColorRE.MatchString(out.Color) {
		return nil, fmt.Errorf("avatar color must be a #rrggbb hex colour")
	}
	return &out, nil
}
