package main

import (
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/cmd/wuphf/channelui"
)

func TestBuildOfficeIntroLinesUsesWorkspaceState(t *testing.T) {
	// Pin memory backend to none — this test asserts the "local-only
	// runtime" card, and the shipping default is the markdown wiki, so we opt
	// in to local-only explicitly.
	t.Setenv("WUPHF_MEMORY_BACKEND", "none")
	m := newChannelModel(false)
	m.brokerConnected = true
	m.members = []channelui.Member{{Slug: "ceo", Name: "CEO"}, {Slug: "pm", Name: "Product Manager"}}
	m.tasks = []channelui.Task{{ID: "task-1", Title: "Ship launch", Status: "in_progress", Owner: "pm"}}
	m.requests = []channelui.Interview{{ID: "req-1", Kind: "approval", Status: "pending", Title: "Approve launch copy", Question: "Approve launch copy?", From: "ceo"}}

	lines := m.buildOfficeIntroLines(96)
	plain := stripANSI(joinRenderedLines(lines))

	if !strings.Contains(plain, "Welcome to gawkbot.") {
		t.Fatalf("expected welcome copy, got %q", plain)
	}
	if !strings.Contains(plain, "Local-only runtime") {
		t.Fatalf("expected local-only readiness card, got %q", plain)
	}
	if !strings.Contains(plain, "Set --memory-backend gbrain or --memory-backend markdown to enable organizational context.") {
		t.Fatalf("expected memory-backend guidance, got %q", plain)
	}
}

func TestBuildOfficeIntroLinesShowsOfflinePreviewGuidance(t *testing.T) {
	m := newChannelModel(false)
	m.brokerConnected = false

	lines := m.buildOfficeIntroLines(96)
	plain := stripANSI(joinRenderedLines(lines))

	if !strings.Contains(plain, "Offline preview") {
		t.Fatalf("expected offline preview messaging, got %q", plain)
	}
	if !strings.Contains(plain, "Launch gawkbot to attach the live team, or run /doctor to inspect runtime readiness.") {
		t.Fatalf("expected doctor guidance, got %q", plain)
	}
}

func TestBuildDirectIntroLinesPreservesDirectSessionResetLanguage(t *testing.T) {
	m := newChannelModel(false)
	m.sessionMode = "1o1"
	m.oneOnOneBot = "be"

	lines := m.buildDirectIntroLines(96)
	plain := stripANSI(joinRenderedLines(lines))

	if !strings.Contains(plain, "Direct session reset. Bot pane reloaded in place.") {
		t.Fatalf("expected direct-session reset copy, got %q", plain)
	}
	if !strings.Contains(plain, "Use /switcher to jump back to the team.") {
		t.Fatalf("expected switcher guidance in direct intro, got %q", plain)
	}
}

func TestCurrentHeaderMetaUsesWorkspaceStateForOfficeMessages(t *testing.T) {
	m := newChannelModel(false)
	m.activeApp = channelui.OfficeAppMessages
	m.activeChannel = "launch"
	m.brokerConnected = true
	m.members = []channelui.Member{{Slug: "ceo", Name: "CEO"}, {Slug: "pm", Name: "Product Manager"}}
	m.tasks = []channelui.Task{{ID: "task-1", Title: "Ship launch", Status: "in_progress", Owner: "pm"}}
	m.requests = []channelui.Interview{{ID: "req-1", Kind: "approval", Status: "pending", Title: "Approve launch copy", Question: "Approve launch copy?", From: "ceo", Blocking: true}}

	meta := stripANSI(m.currentHeaderMeta())
	if !strings.Contains(meta, "2 teammates") {
		t.Fatalf("expected teammate count in header meta, got %q", meta)
	}
	if !strings.Contains(meta, "1 waiting on you") {
		t.Fatalf("expected blocking request count in header meta, got %q", meta)
	}
}

func TestCurrentWorkspaceUIStatePromotesDoctorWarningsIntoReadiness(t *testing.T) {
	// Same pin as TestBuildOfficeIntroLinesUsesWorkspaceState — the
	// readiness card asserted here is the "Local-only" variant.
	t.Setenv("WUPHF_MEMORY_BACKEND", "none")
	m := newChannelModel(false)
	m.brokerConnected = true
	m.activeChannel = "general"
	m.doctor = &channelui.DoctorReport{
		Checks: []channelui.DoctorCheck{
			{
				Label:    "Connected accounts",
				Severity: channelui.DoctorWarn,
				Detail:   "No accounts connected.",
				NextStep: "Connect Gmail, CRM, or another account in the provider dashboard.",
			},
		},
	}

	state := m.currentWorkspaceUIState()
	if state.Readiness.Level != channelui.WorkspaceReadinessReady {
		t.Fatalf("expected ready local-only readiness, got %+v", state.Readiness)
	}
	if !strings.Contains(state.Readiness.Headline, "Local-only") {
		t.Fatalf("expected local-only readiness headline, got %+v", state.Readiness)
	}
}
