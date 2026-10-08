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
	postMember(t, b, `{"action":"create","slug":"scout","avatar":{"shape":"bean","color":"#a8546b"}}`)
	s := fetchNotchState(t, b)
	a := notchAgentBySlug(t, s, "scout")
	if a.Avatar == nil || a.Avatar.Shape != "bean" || a.Avatar.Color != "#a8546b" {
		t.Fatalf("notch avatar = %+v", a.Avatar)
	}
}

func TestAvatarShapesMatchTheWebSilhouetteCount(t *testing.T) {
	// web/src/lib/blobAvatar.ts SILHOUETTES has eight entries in this order.
	if len(AvatarShapes) != 8 || AvatarShapes[0] != "block" || AvatarShapes[7] != "blob" {
		t.Fatalf("AvatarShapes = %v", AvatarShapes)
	}
}
