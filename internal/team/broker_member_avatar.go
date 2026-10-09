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
	out := MemberAvatar{
		Shape: strings.ToLower(strings.TrimSpace(a.Shape)),
		Color: strings.ToLower(strings.TrimSpace(a.Color)),
	}
	if out.Shape == "" && out.Color == "" {
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
