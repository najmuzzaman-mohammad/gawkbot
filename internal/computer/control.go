package computer

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Who is driving a bot's computer: the person or the bot. One record per
// bot, in memory on purpose. A hold is a live fact about who is at the
// screen right now; surviving a broker restart would mean a stale hold
// silently refusing every action of a bot nobody is watching.
//
// Rules:
//   - A bot can only ASK for hands (RequestHelp). It can never take control
//     and it cannot clear a hold. Only the person takes and releases.
//   - While the person holds control, the bot's actions are REFUSED by the
//     bridge, not queued. A queued click would land after the person moved
//     on, on whatever happens to be under it.
//   - Releasing control also settles any open help request, so a bot waiting
//     in RequestHelp wakes from the same state change the person made.

// Snapshot is the panel's and the bridge's view of one bot's control.
type Snapshot struct {
	Held bool `json:"held"`
	// HelpReason is the bot's open plea, or nil when none is open.
	HelpReason  *string `json:"help_reason"`
	HelpOpen    bool    `json:"help_open"`
	HeldSinceMs int64   `json:"held_since_ms,omitempty"`
	// ConsentOpen is a bot on the person's Mac waiting to be allowed its
	// first action of the turn; ConsentSummary says what it wants.
	ConsentOpen    bool    `json:"consent_open,omitempty"`
	ConsentSummary *string `json:"consent_summary,omitempty"`
	// ConsentDecision is the person's last answer: allow, allow_always,
	// deny, or empty while nothing was asked or answered.
	ConsentDecision string `json:"consent_decision,omitempty"`
	// Revision increments on every change; the screen poller uses it to
	// discard a frame captured across a takeover.
	Revision int `json:"revision"`
}

// The person's answers to a consent request.
const (
	ConsentAllow       = "allow"
	ConsentAllowAlways = "allow_always"
	ConsentDeny        = "deny"
)

type controlRecord struct {
	held            bool
	heldSince       time.Time
	helpReason      string
	helpRequestID   string
	consentSummary  string
	consentID       string
	consentDecision string
	revision        int
}

// Control is the registry of holds and help requests.
type Control struct {
	mu      sync.Mutex
	records map[string]*controlRecord
	// OnChange, when set, is called after every change with the new
	// snapshot so the broker can fan it out over SSE. Called without the
	// lock held.
	OnChange func(slug string, snapshot Snapshot)
}

func (c *Control) record(slug string) *controlRecord {
	if c.records == nil {
		c.records = map[string]*controlRecord{}
	}
	r, ok := c.records[slug]
	if !ok {
		r = &controlRecord{}
		c.records[slug] = r
	}
	return r
}

func (r *controlRecord) snapshot() Snapshot {
	s := Snapshot{Held: r.held, Revision: r.revision, HelpOpen: r.helpReason != "", ConsentOpen: r.consentSummary != "", ConsentDecision: r.consentDecision}
	if r.helpReason != "" {
		reason := r.helpReason
		s.HelpReason = &reason
	}
	if r.consentSummary != "" {
		summary := r.consentSummary
		s.ConsentSummary = &summary
	}
	if r.held {
		s.HeldSinceMs = r.heldSince.UnixMilli()
	}
	return s
}

// Snapshot reads one bot's control without changing it.
func (c *Control) Snapshot(slug string) Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.record(slug).snapshot()
}

func (c *Control) mutate(slug string, fn func(r *controlRecord) bool) Snapshot {
	c.mu.Lock()
	r := c.record(slug)
	changed := fn(r)
	if changed {
		r.revision++
	}
	s := r.snapshot()
	c.mu.Unlock()
	if changed && c.OnChange != nil {
		c.OnChange(slug, s)
	}
	return s
}

// Take gives the person the wheel. Taking also answers an open help request.
func (c *Control) Take(slug string) Snapshot {
	return c.mutate(slug, func(r *controlRecord) bool {
		if r.held && r.helpReason == "" {
			return false
		}
		r.held = true
		r.heldSince = time.Now()
		r.helpReason = ""
		r.helpRequestID = ""
		return true
	})
}

// Release hands the wheel back to the bot.
func (c *Control) Release(slug string) Snapshot {
	return c.mutate(slug, func(r *controlRecord) bool {
		if !r.held && r.helpReason == "" {
			return false
		}
		r.held = false
		r.heldSince = time.Time{}
		r.helpReason = ""
		r.helpRequestID = ""
		return true
	})
}

// DismissHelp closes the bot's plea without taking control.
func (c *Control) DismissHelp(slug string) Snapshot {
	return c.mutate(slug, func(r *controlRecord) bool {
		if r.helpReason == "" {
			return false
		}
		r.helpReason = ""
		r.helpRequestID = ""
		return true
	})
}

// RequestHelp records the bot's plea and returns its id, so the bridge can
// expire only its own request later.
func (c *Control) RequestHelp(slug, reason string) (string, Snapshot) {
	id := randomID()
	s := c.mutate(slug, func(r *controlRecord) bool {
		r.helpReason = firstNonEmpty(reason, "The bot asked for your hands")
		r.helpRequestID = id
		return true
	})
	return id, s
}

// ExpireHelp closes the plea only if it is still the one identified by id.
func (c *Control) ExpireHelp(slug, id string) Snapshot {
	return c.mutate(slug, func(r *controlRecord) bool {
		if r.helpReason == "" || r.helpRequestID != id {
			return false
		}
		r.helpReason = ""
		r.helpRequestID = ""
		return true
	})
}

// RequestConsent records that a bot on the Mac wants to act this turn and
// returns the request's id. A second request replaces the first.
func (c *Control) RequestConsent(slug, summary string) (string, Snapshot) {
	id := randomID()
	s := c.mutate(slug, func(r *controlRecord) bool {
		r.consentSummary = firstNonEmpty(summary, "wants to use this Mac")
		r.consentID = id
		r.consentDecision = ""
		return true
	})
	return id, s
}

// Decide is the person's answer to an open consent request. An answer with
// nothing open still records the decision, so a bot that asks a moment
// later reads it.
func (c *Control) Decide(slug, decision string) Snapshot {
	switch decision {
	case ConsentAllow, ConsentAllowAlways, ConsentDeny:
	default:
		return c.Snapshot(slug)
	}
	return c.mutate(slug, func(r *controlRecord) bool {
		r.consentSummary = ""
		r.consentID = ""
		r.consentDecision = decision
		return true
	})
}

// ExpireConsent closes the request only if it is still the one identified
// by id, with no decision.
func (c *Control) ExpireConsent(slug, id string) Snapshot {
	return c.mutate(slug, func(r *controlRecord) bool {
		if r.consentSummary == "" || r.consentID != id {
			return false
		}
		r.consentSummary = ""
		r.consentID = ""
		return true
	})
}

// Forget drops a bot's record, for example when the bot is deleted.
func (c *Control) Forget(slug string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.records, slug)
}

func randomID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return time.Now().Format("20060102150405.000000")
	}
	return hex.EncodeToString(b)
}
