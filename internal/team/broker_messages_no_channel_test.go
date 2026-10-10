package team

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A message with no channel from a sender that has no home channel is
// refused, and the office keeps working afterwards. The refusal used to
// return with the broker's lock still held, so this one request froze every
// other route (the notch, the member list, health) until the app was quit.
func TestPostMessageWithNoChannelIsRefusedAndReleasesTheLock(t *testing.T) {
	if generalChannelEnabled() {
		t.Skip("with the shared room on, a message with no channel has a home")
	}
	b := NewBrokerAt(filepath.Join(t.TempDir(), "broker-state.json"))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/messages", strings.NewReader(`{"from":"you","channel":"","content":"hello"}`))
	b.handlePostMessage(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "channel is required") {
		t.Fatalf("status %d body %q, want 400 channel is required", rec.Code, rec.Body.String())
	}

	free := make(chan struct{})
	go func() {
		b.mu.Lock()
		close(free)
		b.mu.Unlock()
	}()
	select {
	case <-free:
	case <-time.After(5 * time.Second):
		t.Fatal("the broker lock is still held after the refusal: every other route is now frozen")
	}
}
