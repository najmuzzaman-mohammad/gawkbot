package team

import (
	"net"
	"strings"
	"testing"
	"time"
)

// TestSkipTaskSeedsWelcomeOnly asserts the post-R6 onboarding invariant:
// when the wizard finishes with skip_task=true, the human lands with the
// system welcome and NO staged bot presence line. The demo_seed
// machinery was removed (core-loop R6) — the loop wants a real first
// paint, so any reappearance of a synthetic bot post here is a
// regression.
//
// The welcome now lands in the LEAD's DM rather than #general. That is the
// point of the retirement: there is no shared room to open into, so the first
// thing the human sees has to be a conversation with somebody.
func TestSkipTaskSeedsWelcomeOnly(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("", true, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	lead := officeLeadSlugFromMembers(b.members)
	b.mu.Unlock()
	if lead == "" {
		lead = "ceo"
	}
	home := DMSlugFor(lead)
	msgs := b.ChannelMessages(home)
	// The old contract was a "Welcome to your team" post From "system". The
	// founder's onboarding spec replaced it: with no task kicked off, the
	// Chief of Staff itself opens the DM, introduces what it does, and asks
	// for the goal. So the pin flips: the opener comes FROM the lead, and
	// nothing here speaks as "system". The demo_seed guard stays — R6 removed
	// staged fake presence and it must not creep back through this path.
	var intro *channelMessage
	for i := range msgs {
		m := &msgs[i]
		if m.Kind == "demo_seed" {
			t.Errorf("demo_seed message seeded in the lead DM after R6 removal: %+v", *m)
		}
		if m.From == lead {
			intro = m
		}
	}
	if intro == nil {
		t.Fatalf("expected the Chief of Staff intro in %s; got %d messages: %+v", home, len(msgs), msgs)
	}
	if !strings.Contains(intro.Content, "what are you trying to get done") {
		t.Errorf("intro does not ask for the goal; content = %q", intro.Content)
	}
	if strings.Contains(intro.Content, "I am CEO") {
		t.Errorf("intro uses the retired display name: %q", intro.Content)
	}
}

// TestServeWebUIReturnsErrorOnBoundPort asserts that ServeWebUI surfaces a
// port-conflict error synchronously rather than swallowing it inside the
// goroutine. Pre-fix this was a log.Printf that left the launcher claiming
// success while the listener was dead.
func TestServeWebUIReturnsErrorOnBoundPort(t *testing.T) {
	hold, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer hold.Close()
	port := hold.Addr().(*net.TCPAddr).Port

	b := newTestBroker(t)
	if err := b.ServeWebUI(port); err == nil {
		t.Fatalf("ServeWebUI on busy port %d returned nil error", port)
	}
}

// TestWaitForWebReadyTimesOutOnDeadAddr asserts the negative-path return
// value the launcher relies on to skip openBrowser. Picks an unbound port
// (closed-and-released) and a tight ceiling so the test stays sub-second.
func TestWaitForWebReadyTimesOutOnDeadAddr(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close()

	start := time.Now()
	if waitForWebReady(addr, 200*time.Millisecond) {
		t.Fatalf("waitForWebReady on dead %s returned true", addr)
	}
	if elapsed := time.Since(start); elapsed > 1*time.Second {
		t.Fatalf("waitForWebReady took %v on dead addr; expected ≤ ~timeout", elapsed)
	}
}

// TestWaitForWebReadyReturnsTrueOnLiveAddr asserts the positive-path
// return so we know the bool gate distinguishes the two states (otherwise
// "always returns false" would silently pass the negative test alone).
func TestWaitForWebReadyReturnsTrueOnLiveAddr(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	addr := ln.Addr().String()

	if !waitForWebReady(addr, 2*time.Second) {
		t.Fatalf("waitForWebReady on live %s returned false", addr)
	}
}
