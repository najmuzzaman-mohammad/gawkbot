package team

import (
	"errors"
	"testing"
)

// postInboundSurfaceMessage auto-creates a DM channel on first message, the
// same way handlePostMessage does. Its sibling re-checks that the channel
// actually exists afterwards (broker_messages.go); this path did not.
//
// ensureDMConversationLocked returns nil whenever the slug has no resolvable
// participant, so the call fell through and appended the message to a channel
// that does not exist — a silent write to a dead room, which is exactly the
// failure mode that matters once DMs are the only conversation surface there
// is. These pin the guard.

// messageCountLocked counts persisted messages in a channel, without going
// through the access-checked read path.
func messageCountFor(b *Broker, channel string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, m := range b.messages {
		if normalizeChannelSlug(m.Channel) == normalizeChannelSlug(channel) {
			n++
		}
	}
	return n
}

func TestSurfaceMessageToUnresolvableDMFailsInsteadOfPersisting(t *testing.T) {
	t.Parallel()
	b := newTestBroker(t)

	// The bare "dm-" is a DM slug by prefix but names no bot, so
	// DMTargetBot is "" and ensureDMConversationLocked gives up.
	_, err := b.PostInboundSurfaceMessage("human", "dm-", "hello nobody", "slack")

	if err == nil {
		t.Fatal("posting to an unresolvable DM slug must fail, not silently persist")
	}
	if !errors.Is(err, ErrChannelNotFound) {
		t.Fatalf("expected ErrChannelNotFound, got %v", err)
	}
	if n := messageCountFor(b, "dm-"); n != 0 {
		t.Errorf("no message may be persisted to a non-existent channel; found %d", n)
	}
	if n := len(b.messages); n != 0 {
		t.Errorf("no message may be persisted anywhere; found %d", n)
	}
}

func TestSurfaceMessageToUnresolvableDMDoesNotMintAChannel(t *testing.T) {
	t.Parallel()
	b := newTestBroker(t)

	_, _ = b.PostInboundSurfaceMessage("human", "dm-", "hello nobody", "slack")

	b.mu.Lock()
	defer b.mu.Unlock()
	if ch := b.findChannelLocked("dm-"); ch != nil {
		t.Errorf("a failed DM auto-create must leave no channel behind; got %+v", ch)
	}
}

func TestSurfaceMessageToResolvableDMStillAutoCreatesAndPosts(t *testing.T) {
	t.Parallel()
	b := newTestBroker(t)

	// The happy path the guard must not break: a DM slug that names a real
	// bot is created on first message and the message lands in it.
	msg, err := b.PostInboundSurfaceMessage("human", "dm-eng", "ship it", "slack")
	if err != nil {
		t.Fatalf("resolvable DM must still auto-create: %v", err)
	}
	if msg.Content != "ship it" {
		t.Errorf("message content lost; got %q", msg.Content)
	}

	b.mu.Lock()
	ch := b.findChannelLocked(msg.Channel)
	b.mu.Unlock()
	if ch == nil {
		t.Fatalf("the DM channel %q must exist after auto-create", msg.Channel)
	}
	if n := messageCountFor(b, msg.Channel); n != 1 {
		t.Errorf("expected exactly one persisted message, found %d", n)
	}
}

func TestSurfaceMessageToMissingRegularChannelStillFails(t *testing.T) {
	t.Parallel()
	b := newTestBroker(t)

	// Regression guard on the non-DM arm: it errored before and must still.
	_, err := b.PostInboundSurfaceMessage("human", "no-such-room", "hello", "slack")
	if !errors.Is(err, ErrChannelNotFound) {
		t.Fatalf("expected ErrChannelNotFound for a missing channel, got %v", err)
	}
	if n := len(b.messages); n != 0 {
		t.Errorf("no message may be persisted; found %d", n)
	}
}
