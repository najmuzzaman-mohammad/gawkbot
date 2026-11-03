package team

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postMember(t *testing.T, b *Broker, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	b.handleOfficeMembers(rec, httptest.NewRequest(http.MethodPost, "/office-members", strings.NewReader(body)))
	return rec
}

func TestMemberAvatarIsChosenValidatedAndClearable(t *testing.T) {
	b := newTestBroker(t)
	if rec := postMember(t, b, `{"action":"create","slug":"scout","avatar":{"shape":"Drop","color":"#3F9C8F"}}`); rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	m := b.findMemberLocked("scout")
	if m.Avatar == nil || m.Avatar.Shape != "drop" || m.Avatar.Color != "#3f9c8f" {
		t.Fatalf("avatar = %+v, want normalised drop/#3f9c8f", m.Avatar)
	}

	for _, bad := range []string{
		`{"action":"update","slug":"scout","avatar":{"shape":"triangle"}}`,
		`{"action":"update","slug":"scout","avatar":{"color":"red"}}`,
		`{"action":"create","slug":"x2","avatar":{"color":"#12345"}}`,
	} {
		if rec := postMember(t, b, bad); rec.Code != http.StatusBadRequest {
			t.Errorf("%s -> %d, want 400", bad, rec.Code)
		}
	}
	if b.findMemberLocked("scout").Avatar.Shape != "drop" {
		t.Fatal("a rejected update must leave the avatar alone")
	}

	// Leaving avatar out of an update keeps it; sending {} clears it.
	postMember(t, b, `{"action":"update","slug":"scout","role":"Scout"}`)
	if b.findMemberLocked("scout").Avatar == nil {
		t.Fatal("an update without avatar must keep the chosen look")
	}
	postMember(t, b, `{"action":"update","slug":"scout","avatar":{}}`)
	if b.findMemberLocked("scout").Avatar != nil {
		t.Fatal(`avatar {} must clear back to the derived look`)
	}
}

func TestNotchStateCarriesChosenAvatars(t *testing.T) {
	b := newTestBroker(t)
	postMember(t, b, `{"action":"create","slug":"scout","avatar":{"shape":"seacow","color":"#a8546b"}}`)
	s := fetchNotchState(t, b)
	a := notchAgentBySlug(t, s, "scout")
	if a.Avatar == nil || a.Avatar.Shape != "seacow" || a.Avatar.Color != "#a8546b" {
		t.Fatalf("notch avatar = %+v", a.Avatar)
	}
}

func TestAvatarShapesMatchTheWebBodies(t *testing.T) {
	// web/src/lib/blobAvatar.ts AVATAR_SHAPES has eight entries in this order.
	if len(AvatarShapes) != 8 || AvatarShapes[0] != "bear" || AvatarShapes[7] != "flower" {
		t.Fatalf("AvatarShapes = %v", AvatarShapes)
	}
}

func TestLegacyAvatarShapesBecomeOrbs(t *testing.T) {
	// A bot that chose a look before the orbs keeps a look.
	b := newTestBroker(t)
	if rec := postMember(t, b, `{"action":"create","slug":"scout","avatar":{"shape":"Shield"}}`); rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	if got := b.findMemberLocked("scout").Avatar.Shape; got != "ghost" {
		t.Fatalf("shield -> %q, want ghost", got)
	}
	if len(legacyAvatarShapes) != 8 {
		t.Fatalf("legacyAvatarShapes has %d entries, want the eight old ids", len(legacyAvatarShapes))
	}
	for old, now := range legacyAvatarShapes {
		known := false
		for _, s := range AvatarShapes {
			known = known || s == now
		}
		if !known {
			t.Errorf("%s maps to %q, which is not an orb body", old, now)
		}
	}
}

func TestNormalizeMemberLook(t *testing.T) {
	if l, err := normalizeMemberLook(nil); l != nil || err != nil {
		t.Fatalf("nil: %+v %v", l, err)
	}
	if l, err := normalizeMemberLook(&MemberLook{Hair: "none", Eyes: "default", Accessory: "none", HairColor: "#ff00aa"}); l != nil || err != nil {
		t.Fatalf("all none is no look: %+v %v", l, err)
	}
	l, err := normalizeMemberLook(&MemberLook{Hair: " Bob ", HairColor: "#FF00AA", Eyes: "glasses", Accessory: "scarf"})
	if err != nil || l == nil || l.Hair != "bob" || l.HairColor != "#ff00aa" || l.Eyes != "glasses" || l.Accessory != "scarf" {
		t.Fatalf("look: %+v %v", l, err)
	}
	if _, err := normalizeMemberLook(&MemberLook{Hair: "rainbow"}); err == nil {
		t.Fatal("unknown hair accepted")
	}
	if _, err := normalizeMemberLook(&MemberLook{Eyes: "laser"}); err == nil {
		t.Fatal("unknown eyes accepted")
	}
	if _, err := normalizeMemberLook(&MemberLook{Hair: "tuft", HairColor: "red"}); err == nil {
		t.Fatal("bad hair colour accepted")
	}
	// A hair colour with no hair is dropped; a look rides on the avatar.
	if l, _ := normalizeMemberLook(&MemberLook{Eyes: "wink", HairColor: "#ff00aa"}); l.HairColor != "" {
		t.Fatalf("hair colour without hair kept: %+v", l)
	}
	a, err := normalizeMemberAvatar(&MemberAvatar{Look: &MemberLook{Accessory: "bow"}})
	if err != nil || a == nil || a.Look == nil || a.Look.Accessory != "bow" || a.Shape != "" {
		t.Fatalf("avatar with only a look: %+v %v", a, err)
	}
}
