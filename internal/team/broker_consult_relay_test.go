package team

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// The consult relay markers exist so a human can tell a researched answer from
// an invented one: if your bot says "Social says X", there is a marker
// showing it actually asked. These tests pin the properties that claim rests
// on — that a marker appears only when a real message exists, that it names
// the right peer and direction, and that it never becomes somebody talking.

func relayBroker(t *testing.T) *Broker {
	t.Helper()
	b := newBrokerWithTeamRoom(filepath.Join(t.TempDir(), "state.json"))
	b.mu.Lock()
	b.members = []officeMember{
		{Slug: "ops", Name: "Bagel Ops", Role: "Operations"},
		{Slug: "social", Name: "Bagel Social", Role: "Social"},
		{Slug: "eng", Name: "Engineer", Role: "Engineer"},
	}
	b.memberIndex = nil
	b.channels = []teamChannel{
		{Slug: "ops__human", Name: "ops__human", Type: "dm", Members: []string{"human", "ops"}},
		{Slug: "ops__social", Name: "ops__social", Type: "dm", Members: []string{"ops", "social"}},
	}
	b.mu.Unlock()
	return b
}

func relayPayload(t *testing.T, msg channelMessage) consultRelayPayload {
	t.Helper()
	var p consultRelayPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		t.Fatalf("marker payload: %v", err)
	}
	return p
}

// The mockup: your bot messages a peer, the peer answers, and both markers
// land in your DM with your bot — outbound then inbound, in order.
func TestConsultMarkersRenderBothDirections(t *testing.T) {
	b := relayBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.messages = []channelMessage{
		{ID: "m1", From: "ops", Channel: "ops__social", Content: "content schedule?", Timestamp: "2026-08-23T10:00:00Z"},
		{ID: "m2", From: "social", Channel: "ops__social", Content: "here it is", Timestamp: "2026-08-23T10:05:00Z"},
	}

	markers := b.deriveConsultMarkersLocked("ops__human")
	if len(markers) != 2 {
		t.Fatalf("expected 2 markers in the human's DM with ops, got %d", len(markers))
	}

	sent := relayPayload(t, markers[0])
	if sent.Direction != consultRelayDirectionSent || sent.Bot != "social" {
		t.Errorf("first marker should be sent->social, got %+v", sent)
	}
	got := relayPayload(t, markers[1])
	if got.Direction != consultRelayDirectionReceived || got.Bot != "social" {
		t.Errorf("second marker should be received-from social, got %+v", got)
	}
	// Both point at the real conversation so the click-through has somewhere
	// to go, and both carry the source timestamp so they interleave correctly.
	for i, m := range markers {
		if p := relayPayload(t, m); p.Channel != "ops__social" {
			t.Errorf("marker %d must link the real DM, got %q", i, p.Channel)
		}
		if m.Kind != consultRelayKind {
			t.Errorf("marker %d kind = %q", i, m.Kind)
		}
	}
	if markers[0].Timestamp != "2026-08-23T10:00:00Z" || markers[1].Timestamp != "2026-08-23T10:05:00Z" {
		t.Errorf("markers must carry their source timestamps, got %q and %q",
			markers[0].Timestamp, markers[1].Timestamp)
	}
}

// A marker is an event, not somebody talking. It must never render as an
// author — that is the thirty-first system sender the office does not want.
func TestConsultMarkerHasNoAuthor(t *testing.T) {
	b := relayBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.messages = []channelMessage{
		{ID: "m1", From: "ops", Channel: "ops__social", Content: "hi", Timestamp: "2026-08-23T10:00:00Z"},
	}
	markers := b.deriveConsultMarkersLocked("ops__human")
	if len(markers) != 1 {
		t.Fatalf("expected 1 marker, got %d", len(markers))
	}
	if markers[0].From != "" {
		t.Fatalf("a relay marker must have no sender, got From=%q", markers[0].From)
	}
	if markers[0].Content != "" {
		t.Fatalf("a relay marker carries no prose, got Content=%q", markers[0].Content)
	}
}

// The honesty property: derived means a bot cannot fabricate one. There is
// no marker without a real message in a real bot-to-bot DM.
func TestNoConsultNoMarker(t *testing.T) {
	b := relayBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	// The bot CLAIMS to have consulted, in its own DM with the human, but
	// never messaged anyone. Its word alone must produce nothing.
	b.messages = []channelMessage{
		{ID: "m1", From: "ops", Channel: "ops__human", Content: "I asked Social and they said yes", Timestamp: "2026-08-23T10:00:00Z"},
	}
	if markers := b.deriveConsultMarkersLocked("ops__human"); len(markers) != 0 {
		t.Fatalf("a claim is not a consult; expected no markers, got %d", len(markers))
	}
}

// Markers follow the participant, not the room: a consult between two OTHER
// bots must not surface in an uninvolved bot's DM.
func TestConsultMarkersDoNotLeakToUninvolvedBots(t *testing.T) {
	b := relayBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.channels = append(b.channels, teamChannel{
		Slug: "eng__human", Name: "eng__human", Type: "dm", Members: []string{"human", "eng"},
	})
	b.messages = []channelMessage{
		{ID: "m1", From: "ops", Channel: "ops__social", Content: "private", Timestamp: "2026-08-23T10:00:00Z"},
	}
	if markers := b.deriveConsultMarkersLocked("eng__human"); len(markers) != 0 {
		t.Fatalf("eng is not in the ops<->social consult; expected no markers, got %d", len(markers))
	}
}

// Only human-to-bot DMs carry markers. A regular channel, and the pair DM
// itself, are not where the relay is narrated.
func TestConsultMarkersOnlyInHumanDMs(t *testing.T) {
	b := relayBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.messages = []channelMessage{
		{ID: "m1", From: "ops", Channel: "ops__social", Content: "hi", Timestamp: "2026-08-23T10:00:00Z"},
	}
	for _, ch := range []string{"team", "ops__social"} {
		if markers := b.deriveConsultMarkersLocked(ch); len(markers) != 0 {
			t.Errorf("channel %q must carry no relay markers, got %d", ch, len(markers))
		}
	}
}

// Marker IDs are derived from the source message, so repeated reads return the
// same ids. Without this, since_id polling would treat every poll as new and
// the web would remount the row on each refresh.
func TestConsultMarkerIDsAreStable(t *testing.T) {
	b := relayBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.messages = []channelMessage{
		{ID: "m1", From: "ops", Channel: "ops__social", Content: "hi", Timestamp: "2026-08-23T10:00:00Z"},
	}
	first := b.deriveConsultMarkersLocked("ops__human")
	second := b.deriveConsultMarkersLocked("ops__human")
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("expected 1 marker per read, got %d and %d", len(first), len(second))
	}
	if first[0].ID != second[0].ID {
		t.Fatalf("marker id must be stable across reads: %q vs %q", first[0].ID, second[0].ID)
	}
	if first[0].ID == "m1" {
		t.Fatalf("marker id must not collide with its source message id")
	}
}

// Derivation is response-only: it must never mutate the stored message log.
// A marker that got persisted would double up on the next read and would also
// reach the notifier and the bot-context builder, which it has no business
// touching.
func TestConsultMarkersAreNotPersisted(t *testing.T) {
	b := relayBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.messages = []channelMessage{
		{ID: "m1", From: "ops", Channel: "ops__social", Content: "hi", Timestamp: "2026-08-23T10:00:00Z"},
	}
	before := len(b.messages)
	_ = b.deriveConsultMarkersLocked("ops__human")
	if len(b.messages) != before {
		t.Fatalf("derivation must not append to the message log: %d -> %d", before, len(b.messages))
	}
}

func TestMergeByTimestampInterleaves(t *testing.T) {
	base := []channelMessage{
		{ID: "a", Timestamp: "2026-08-23T10:00:00Z"},
		{ID: "c", Timestamp: "2026-08-23T10:10:00Z"},
	}
	extra := []channelMessage{
		{ID: "b", Timestamp: "2026-08-23T10:05:00Z"},
		{ID: "d", Timestamp: "2026-08-23T10:20:00Z"},
	}
	got := mergeByTimestamp(base, extra)
	want := []string{"a", "b", "c", "d"}
	if len(got) != len(want) {
		t.Fatalf("expected %d rows, got %d", len(want), len(got))
	}
	for i, id := range want {
		if got[i].ID != id {
			t.Fatalf("merge order = %v, want %v", ids(got), want)
		}
	}
}

// A marker shares its source's timestamp, so the tie must resolve with the
// real message first — the marker annotates it, it does not precede it.
func TestMergeByTimestampKeepsBaseFirstOnTies(t *testing.T) {
	base := []channelMessage{{ID: "real", Timestamp: "2026-08-23T10:00:00Z"}}
	extra := []channelMessage{{ID: "marker", Timestamp: "2026-08-23T10:00:00Z"}}
	got := mergeByTimestamp(base, extra)
	if len(got) != 2 || got[0].ID != "real" {
		t.Fatalf("expected real message first on a tie, got %v", ids(got))
	}
}

func ids(msgs []channelMessage) []string {
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m.ID)
	}
	return out
}
