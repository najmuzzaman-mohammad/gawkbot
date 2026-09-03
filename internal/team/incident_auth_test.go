package team

import (
	"strings"
	"testing"
)

// TestReportIncidentRoutesAuthErrorThroughSystemCard verifies that
// "Not logged in" failures from the bot loop are routed through the
// system-authored SystemErrorCard path instead of being posted as an
// agent_issue bubble. Issue #933 — runtime/auth failures must look
// different from in-character CEO output.
func TestReportIncidentRoutesAuthErrorThroughSystemCard(t *testing.T) {
	b := newTestBroker(t)

	msg, _, posted, err := b.ReportIncident("ceo", "team", "", "Claude CLI requires login. Run `claude login` or use /init to choose a different provider.")
	if err != nil {
		t.Fatalf("ReportIncident: %v", err)
	}
	if !posted {
		t.Fatal("expected the auth-error path to post a system card")
	}
	if msg.From != "system" {
		t.Errorf("expected From=system (banner card), got %q", msg.From)
	}
	if msg.Kind != "system_auth_error" {
		t.Errorf("expected Kind=system_auth_error, got %q", msg.Kind)
	}
	if !strings.Contains(string(msg.Payload), `"provider":"claude-code"`) {
		t.Errorf("expected payload to include provider=claude-code, got %s", string(msg.Payload))
	}
	if !strings.Contains(string(msg.Payload), `"sign_in_command":"claude auth login"`) {
		t.Errorf("expected payload to include sign_in_command, got %s", string(msg.Payload))
	}
	// The incidents list must be empty — the auth path
	// short-circuits before the incident table is touched.
	if len(b.Incidents()) != 0 {
		t.Errorf("auth error must not populate Incidents, got %+v", b.Incidents())
	}
}

// TestReportIncidentAuthErrorIdentifiesCodex covers the codex variant
// of the runtime-specific sign-in CTA.
func TestReportIncidentAuthErrorIdentifiesCodex(t *testing.T) {
	b := newTestBroker(t)

	// "ceo" is the bot slug; the test asserts on provider=codex detected
	// from the message text (the Codex CLI's auth-error string), not on the
	// bot's identity. Using "ceo" keeps the canAccessChannelLocked gate
	// happy in a fresh broker where non-built-in bots aren't channel
	// members yet.
	msg, _, posted, err := b.ReportIncident("ceo", "team", "", "Codex CLI requires login. Run `codex login` or use /provider to choose a different provider.")
	if err != nil {
		t.Fatalf("ReportIncident: %v", err)
	}
	if !posted {
		t.Fatal("expected the auth-error path to post a system card")
	}
	if msg.Kind != "system_auth_error" {
		t.Errorf("expected Kind=system_auth_error, got %q", msg.Kind)
	}
	if !strings.Contains(string(msg.Payload), `"provider":"codex"`) {
		t.Errorf("expected payload to include provider=codex, got %s", string(msg.Payload))
	}
	if !strings.Contains(string(msg.Payload), `"sign_in_command":"codex login"`) {
		t.Errorf("expected payload to include codex sign_in_command, got %s", string(msg.Payload))
	}
}

// TestReportIncidentAuthErrorDedupesWithinChannel ensures that
// repeated auth errors from the same provider don't stack identical
// banners. The first one stays visible; subsequent emits are suppressed.
func TestReportIncidentAuthErrorDedupesWithinChannel(t *testing.T) {
	b := newTestBroker(t)

	_, _, posted1, err := b.ReportIncident("ceo", "team", "", "claude requires login. run `claude login`")
	if err != nil || !posted1 {
		t.Fatalf("first auth error: posted=%v err=%v", posted1, err)
	}
	_, _, posted2, err := b.ReportIncident("ceo", "team", "", "claude requires login. run `claude login`")
	if err != nil {
		t.Fatalf("second auth error: %v", err)
	}
	if posted2 {
		t.Error("second identical auth banner should be deduped")
	}

	// Exactly one system_auth_error in the channel.
	count := 0
	for _, m := range b.ChannelMessages("team") {
		if m.Kind == "system_auth_error" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected exactly one system_auth_error banner, got %d", count)
	}
}

// TestReportIncidentAuthErrorEnforcesChannelACL regression-guards
// the CodeRabbit finding on PR #985: the system-auth fork must respect
// canAccessChannelLocked just like the legacy incident path, so an
// bot that isn't a member of a channel can't surface an auth banner
// in it via the auth fork.
func TestReportIncidentAuthErrorEnforcesChannelACL(t *testing.T) {
	b := newTestBroker(t)
	// "eng" is not a built-in, not channel ceo/system/nex/human, and not
	// a member of the default #general channel created at boot.
	_, _, posted, err := b.ReportIncident("eng", "team", "", "Claude CLI requires login. Run `claude login`.")
	if err == nil {
		t.Fatal("expected ACL denial on auth-fork path for non-member bot")
	}
	if !strings.Contains(err.Error(), "channel access denied") {
		t.Errorf("expected channel-access-denied error, got %v", err)
	}
	if posted {
		t.Error("expected posted=false when ACL denies")
	}
}

// TestReportIncidentLeavesNonAuthErrorsAsBotIssue verifies the fork
// is precise: non-auth visible incidents still take the legacy agent_issue
// message-kind path so self-heal approval flows aren't broken.
func TestReportIncidentLeavesNonAuthErrorsAsBotIssue(t *testing.T) {
	b := newTestBroker(t)

	msg, _, posted, err := b.ReportIncident("ceo", "team", "", "browser access is not available")
	if err != nil || !posted {
		t.Fatalf("non-auth incident: posted=%v err=%v", posted, err)
	}
	if msg.From != "ceo" {
		t.Errorf("expected non-auth incident to stay bot-authored, got From=%q", msg.From)
	}
	if msg.Kind != "agent_issue" {
		t.Errorf("expected Kind=agent_issue for non-auth path, got %q", msg.Kind)
	}
	if len(b.Incidents()) != 1 {
		t.Errorf("expected one entry in Incidents, got %d", len(b.Incidents()))
	}
}
