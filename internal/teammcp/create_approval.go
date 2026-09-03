package teammcp

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
)

// createApproval describes one blocking "may I create this?" card raised by an
// bot-facing tool. Spinning up durable office structure — a new teammate, a
// new channel — is a persistent act the human owns, so the bot proposes and
// waits.
//
// Shared by requireTeamMemberApproval (member_approval.go) and
// requireTeamChannelApproval (channel_approval.go) so the two gates cannot
// drift in timeout, polling, dedupe, or decline semantics. The external-action
// gate (requireTeamActionApproval in actions.go) keeps its own loop: it returns
// a typed approvalContext and understands steer/hold options this binary gate
// deliberately does not offer.
type createApproval struct {
	// Actor is the requesting bot slug (defaults to "ceo" when empty).
	Actor string
	// Subject names the thing being created in error copy, already sigiled:
	// "@growth" for a member, "#launch" for a channel.
	Subject string
	// Title and Question are the card's heading and the question put to the human.
	Title    string
	Question string
	// Context lines are rendered under the question, one per line.
	Context []string
	// DedupeKey collapses repeated attempts for the same subject onto one card
	// so a bot retry loop cannot stack duplicates.
	DedupeKey string
	// Guidance is appended to decline/timeout errors to route the bot to the
	// right fallback instead of retrying the create.
	Guidance string
}

// requireHumanCreateApproval raises the card and blocks until the human decides.
//
// Returns nil when approved (the caller then performs the create). Returns a
// descriptive error on reject / hold / cancel / timeout, carrying Guidance so
// the bot takes the fallback path rather than retrying.
//
// WUPHF_UNSAFE=1 bypasses the gate, matching the action gate and the --unsafe
// launch flag: an operator who set it has explicitly opted out of every
// approval gate. Human-initiated creation never reaches this path — the UI
// posts to the broker directly; only the bot-facing MCP tools call this.
func requireHumanCreateApproval(ctx context.Context, req createApproval) error {
	if os.Getenv("WUPHF_UNSAFE") == "1" {
		return nil
	}

	actor := strings.TrimSpace(req.Actor)
	if actor == "" {
		actor = "ceo"
	}

	// Advertise ONLY a binary approve/reject pair. These gates have a binary
	// outcome — nil (proceed) or error (don't) — and read no typed guidance, so
	// the stock "approval" set (which adds approve_with_note, reject_with_steer,
	// and hold) would offer steering whose semantics the callers silently
	// discard. Passing an explicit minimal set keeps normalizeHumanRequestOptions
	// from auto-injecting those options; it still enriches the labels and
	// descriptions from the "approval" defaults by ID.
	options, recommendedID := normalizeHumanRequestOptions("approval", "approve", []HumanInterviewOption{
		{ID: "approve"},
		{ID: "reject"},
	})

	var created struct {
		ID string `json:"id"`
	}
	// The approval card goes to the ACTOR's own DM. It was addressed to
	// "general", and this is a BLOCKING, REQUIRED request: filed to a room that
	// no longer exists it is invisible to the human, and the bot waits on it
	// until the approval times out. The actor is resolved just above and is
	// always set, so there is always a real conversation to put it in.
	if err := brokerPostJSON(ctx, "/requests", map[string]any{
		"kind":           "approval",
		"channel":        channel.DirectSlug("human", actor),
		"from":           actor,
		"title":          req.Title,
		"question":       req.Question,
		"context":        strings.Join(req.Context, "\n"),
		"options":        options,
		"recommended_id": recommendedID,
		"blocking":       true,
		"required":       true,
		"dedupe_key":     req.DedupeKey,
	}, &created); err != nil {
		return fmt.Errorf("create approval request for %s: %w", req.Subject, err)
	}
	if strings.TrimSpace(created.ID) == "" {
		return fmt.Errorf("approval request for %s did not return an ID", req.Subject)
	}

	timeout := time.NewTimer(actionApprovalTimeout)
	defer timeout.Stop()
	ticker := time.NewTicker(actionApprovalPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout.C:
			return fmt.Errorf("timed out waiting for human approval to create %s after %s; do NOT retry — %s", req.Subject, actionApprovalTimeout, req.Guidance)
		case <-ticker.C:
			var result brokerInterviewAnswerResponse
			path := "/interview/answer?id=" + url.QueryEscape(created.ID)
			if err := brokerGetJSON(ctx, path, &result); err != nil {
				return fmt.Errorf("poll approval for %s: %w", req.Subject, err)
			}
			switch strings.ToLower(strings.TrimSpace(result.Status)) {
			case "canceled", "cancelled":
				return fmt.Errorf("human canceled the request to create %s; %s", req.Subject, req.Guidance)
			case "not_found":
				return fmt.Errorf("approval request not found for %s", req.Subject)
			}
			if result.Answered == nil {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(result.Answered.ChoiceID)) {
			case "approve", "approve_with_note", "confirm_proceed":
				return nil
			}
			reason := strings.TrimSpace(result.Answered.CustomText)
			if reason == "" {
				reason = strings.TrimSpace(result.Answered.ChoiceText)
			}
			if reason == "" {
				reason = strings.TrimSpace(result.Answered.ChoiceID)
			}
			return fmt.Errorf("human declined to create %s (%s); do NOT retry — %s", req.Subject, reason, req.Guidance)
		}
	}
}
