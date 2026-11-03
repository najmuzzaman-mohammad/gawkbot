package team

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/action"
)

func gmailInFront() notchState {
	return notchState{Screen: &notchScreen{App: "Chrome", BundleID: "com.google.Chrome", Domain: "mail.google.com"}}
}

func TestNotchHintWaitsForThePlatformToStayInFront(t *testing.T) {
	b := newTestBroker(t)
	t0 := time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)
	if s := b.withNotchAppHint(gmailInFront(), true, t0); s.Hint != nil {
		t.Fatal("hinted the moment the page appeared")
	}
	if s := b.withNotchAppHint(gmailInFront(), true, t0.Add(10*time.Second)); s.Hint != nil {
		t.Fatal("hinted before the dwell")
	}
	s := b.withNotchAppHint(gmailInFront(), true, t0.Add(notchHintDwell))
	if s.Hint == nil || s.Hint.Platform != "gmail" || s.Hint.Line != "Connect Gmail so your bots can read this inbox" || s.Hint.Name != "Gmail" {
		t.Fatalf("hint: %+v", s.Hint)
	}
	if s.Hint.Since != t0.Format(time.RFC3339) {
		t.Fatalf("since: %s", s.Hint.Since)
	}
	// Another page resets the dwell; nothing in front clears it.
	other := notchState{Screen: &notchScreen{App: "Chrome", Domain: "github.com"}}
	if s := b.withNotchAppHint(other, true, t0.Add(notchHintDwell+time.Second)); s.Hint != nil {
		t.Fatal("a new page inherited the old dwell")
	}
	if s := b.withNotchAppHint(notchState{}, true, t0.Add(2*notchHintDwell)); s.Hint != nil {
		t.Fatal("hinted with nothing in front")
	}
	if s := b.withNotchAppHint(gmailInFront(), false, t0.Add(3*notchHintDwell)); s.Hint != nil {
		t.Fatal("a joined human was hinted")
	}
}

func TestNotchHintStaysQuietForConnectedPlatformsAndOpenCards(t *testing.T) {
	b := newTestBroker(t)
	t0 := time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)
	b.withNotchAppHint(gmailInFront(), true, t0)
	b.upsertConnectionRegistry(connectionRegistryEntry{Platform: "gmail", State: string(action.StateConnected), ConnectionKey: "ck"})
	if s := b.withNotchAppHint(gmailInFront(), true, t0.Add(notchHintDwell)); s.Hint != nil {
		t.Fatal("hinted a connected platform")
	}
	b2 := newTestBroker(t)
	b2.withNotchAppHint(gmailInFront(), true, t0)
	b2.ensureConnectRequest("gmail", "", "cos", "Gmail", "")
	if s := b2.withNotchAppHint(gmailInFront(), true, t0.Add(notchHintDwell)); s.Hint != nil {
		t.Fatal("hinted beside an open Connect card")
	}
}

func TestNotchHintCapsAndDismissalsPersist(t *testing.T) {
	b := newTestBroker(t)
	t0 := time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)
	front := func(domain string) notchState {
		return notchState{Screen: &notchScreen{App: "Chrome", Domain: domain}}
	}
	// Three platforms shown today; the fourth waits for tomorrow.
	for _, d := range []string{"mail.google.com", "github.com", "linear.app"} {
		b.withNotchAppHint(front(d), true, t0)
		s := b.withNotchAppHint(front(d), true, t0.Add(notchHintDwell))
		if s.Hint == nil {
			t.Fatalf("%s: no hint", d)
		}
		if err := b.markNotchHint(s.Hint.Platform, false, t0); err != nil {
			t.Fatal(err)
		}
	}
	b.withNotchAppHint(front("notion.so"), true, t0)
	if s := b.withNotchAppHint(front("notion.so"), true, t0.Add(notchHintDwell)); s.Hint != nil {
		t.Fatal("a fourth platform was hinted the same day")
	}
	tomorrow := t0.Add(24 * time.Hour)
	b.withNotchAppHint(front("notion.so"), true, tomorrow)
	if s := b.withNotchAppHint(front("notion.so"), true, tomorrow.Add(notchHintDwell)); s.Hint == nil {
		t.Fatal("the day did not turn over")
	}
	// Not now twice ends gmail for good, and a restart remembers.
	if err := b.markNotchHint("gmail", true, tomorrow); err != nil {
		t.Fatal(err)
	}
	b.withNotchAppHint(front("mail.google.com"), true, tomorrow)
	if s := b.withNotchAppHint(front("mail.google.com"), true, tomorrow.Add(notchHintDwell)); s.Hint != nil {
		t.Fatal("hinted again on the day it was sent away")
	}
	later := tomorrow.Add(48 * time.Hour)
	b.withNotchAppHint(front("mail.google.com"), true, later)
	if s := b.withNotchAppHint(front("mail.google.com"), true, later.Add(notchHintDwell)); s.Hint == nil {
		t.Fatal("one Not now ended the hints")
	}
	if err := b.markNotchHint("gmail", true, later); err != nil {
		t.Fatal(err)
	}
	again := NewBrokerAt(b.statePath)
	again.withNotchAppHint(front("mail.google.com"), true, later.Add(72*time.Hour))
	if s := again.withNotchAppHint(front("mail.google.com"), true, later.Add(72*time.Hour+notchHintDwell)); s.Hint != nil {
		t.Fatal("two Not nows were forgotten over a restart")
	}
}

func TestNotchHintRoutesAreTheOwners(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	post := func(token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/notch/hint/dismiss", strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchHintDismiss(rec, req)
		return rec
	}
	if rec := post("", `{"platform":"gmail"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("joined human: %d", rec.Code)
	}
	if rec := post("owner-token", `{"platform":" "}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("no platform: %d", rec.Code)
	}
	if rec := post("owner-token", `{"platform":"Gmail"}`); rec.Code != http.StatusOK {
		t.Fatalf("dismiss: %d %s", rec.Code, rec.Body.String())
	}
	s := &b.notchHints
	s.mu.Lock()
	rec := s.records["gmail"]
	s.mu.Unlock()
	if rec == nil || rec.Dismissed != 1 {
		t.Fatalf("record: %+v", rec)
	}
}
