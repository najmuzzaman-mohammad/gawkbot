package team

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
)

func TestNotchRowsCarryTheLastLineAndWhatIsUnread(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	now := time.Now().UTC()
	dm := channel.DirectSlug("human", "ops")
	// Ids minted like the broker's own, in order.
	say := func(from, text string) string {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.counter++
		id := fmt.Sprintf("msg-%d", b.counter)
		b.messages = append(b.messages, channelMessage{ID: id, From: from, Channel: dm, Content: text, Timestamp: now.Format(time.RFC3339)})
		return id
	}
	b.mu.Lock()
	addNotchBot(b, "ops", "Ops")
	b.mu.Unlock()
	say("human", "move the screenshots")
	say("ops", "On it.")
	last := say("ops", "Done: 14 files moved.")

	row := func(token string) notchAgent {
		s := notchStateAs(t, b, token, "")
		for _, a := range s.Agents {
			if a.Slug == "ops" {
				return a
			}
		}
		t.Fatal("no ops row")
		return notchAgent{}
	}
	a := row("owner-token")
	if a.Channel != dm || a.Last == nil || a.Last.Text != "Done: 14 files moved." || a.Unread != 2 {
		t.Fatalf("row: channel=%q last=%+v unread=%d", a.Channel, a.Last, a.Unread)
	}
	if x := row(""); x.Unread != 0 || x.Last != nil {
		t.Fatal("a joined human saw the owner's conversation")
	}
	read := func(token, id string) int {
		req := httptest.NewRequest(http.MethodPost, "/notch/read", strings.NewReader(`{"channel":"`+dm+`","message_id":"`+id+`"}`))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchRead(rec, req)
		return rec.Code
	}
	if code := read("", last); code != http.StatusForbidden {
		t.Fatalf("joined human marked read: %d", code)
	}
	if code := read("owner-token", last); code != http.StatusOK {
		t.Fatalf("mark: %d", code)
	}
	if a := row("owner-token"); a.Unread != 0 {
		t.Fatalf("still unread after reading: %d", a.Unread)
	}
	// An older mark cannot unread the thread.
	if code := read("owner-token", "msg-1"); code != http.StatusOK {
		t.Fatalf("old mark: %d", code)
	}
	if a := row("owner-token"); a.Unread != 0 {
		t.Fatal("an older mark unread the thread")
	}
	say("ops", "One more thing.")
	if a := row("owner-token"); a.Unread != 1 || a.Last.Text != "One more thing." {
		t.Fatalf("new line: %+v unread=%d", a.Last, a.Unread)
	}
	// The marks survive a restart.
	again := NewBrokerAt(b.statePath)
	if marks := again.notchReadMarks(); marks[dm] != last {
		t.Fatalf("marks after restart: %v", marks)
	}
}
