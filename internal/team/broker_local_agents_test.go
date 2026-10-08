package team

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/provider"
)

func stubLocalAgentScan(t *testing.T, detections ...agentdetect.Detection) {
	t.Helper()
	prev := localAgentScanFn
	localAgentScanFn = func(context.Context) []agentdetect.Detection { return detections }
	t.Cleanup(func() { localAgentScanFn = prev })
}

func detectionFor(t *testing.T, id string, installed bool, running ...int) agentdetect.Detection {
	t.Helper()
	spec, ok := agentdetect.Lookup(id)
	if !ok {
		t.Fatalf("unknown agent %q", id)
	}
	d := agentdetect.Detection{
		ID: spec.ID, Name: spec.Name, Vendor: spec.Vendor, Runtime: spec.Runtime,
		Installed: installed, Adoptable: spec.Adoptable(),
	}
	if installed {
		d.BinaryPath = "/usr/bin/" + spec.Binaries[0]
	}
	switch spec.Runtime {
	case agentdetect.RuntimeNative:
		d.ProviderKind = spec.ProviderKind
	case agentdetect.RuntimeCLI:
		d.ProviderKind = agentdetect.ProviderKindCLIAgent
	}
	for _, pid := range running {
		d.Running = append(d.Running, agentdetect.Process{PID: pid})
	}
	return d
}

func adoptLocalAgents(t *testing.T, b *Broker, body string) localAgentAdoptResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	b.handleAdoptLocalAgents(rec, httptest.NewRequest(http.MethodPost, "/agents/local/adopt", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("adopt status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp localAgentAdoptResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode adopt response: %v", err)
	}
	return resp
}

func listLocalAgents(t *testing.T, b *Broker) localAgentsResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	b.handleLocalAgents(rec, httptest.NewRequest(http.MethodGet, "/agents/local", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp localAgentsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	return resp
}

func TestLocalAgentsListOnlyReportsAgentsFoundOnTheMachine(t *testing.T) {
	stubLocalAgentScan(t,
		detectionFor(t, "claude-code", true, 4242),
		detectionFor(t, "goose", false), // nothing seen: filtered out
		detectionFor(t, "gemini", true),
	)
	b := newTestBroker(t)
	resp := listLocalAgents(t, b)
	if len(resp.Agents) != 2 {
		t.Fatalf("agents = %+v, want claude-code and gemini only", resp.Agents)
	}
	if resp.Agents[0].ID != "claude-code" || len(resp.Agents[0].Running) != 1 {
		t.Fatalf("first agent = %+v, want running claude-code", resp.Agents[0])
	}
	if resp.Lead == "" {
		t.Fatal("response should name the Chief of Staff the agents will report to")
	}
}

func TestAdoptAllLocalAgentsCreatesBotsManagedByTheLead(t *testing.T) {
	stubLocalAgentScan(t,
		detectionFor(t, "codex", true),
		detectionFor(t, "gemini", true),
		detectionFor(t, "aider", false, 77), // running but off PATH: cannot adopt
		detectionFor(t, "cursor", true),     // IDE: never adoptable
	)
	b := newTestBroker(t)
	lead := b.OfficeLeadSlug()

	resp := adoptLocalAgents(t, b, `{"all":true}`)
	if len(resp.Adopted) != 2 {
		t.Fatalf("adopted = %+v skipped = %+v, want codex + gemini", resp.Adopted, resp.Skipped)
	}

	codex := b.findMemberLocked("codex")
	if codex == nil || codex.Provider.Kind != provider.KindCodex {
		t.Fatalf("codex bot = %+v, want a member bound to the codex runtime", codex)
	}
	gemini := b.findMemberLocked("gemini")
	if gemini == nil || gemini.Provider.Kind != provider.KindCLIAgent ||
		gemini.Provider.CLIAgent == nil || gemini.Provider.CLIAgent.Agent != "gemini" {
		t.Fatalf("gemini bot = %+v, want a cli-agent member bound to gemini", gemini)
	}
	for _, m := range []*officeMember{codex, gemini} {
		if m.CreatedBy != lead {
			t.Fatalf("@%s created_by = %q, want the lead %q", m.Slug, m.CreatedBy, lead)
		}
	}

	// The human hears about it from the lead's home channel.
	found := false
	for _, msg := range b.AllMessages() {
		if msg.Kind == "agents_adopted" && strings.Contains(msg.Content, "@gemini") && strings.Contains(msg.Content, "@"+lead) {
			found = true
		}
	}
	if !found {
		t.Fatal("expected an agents_adopted announcement naming the new bots and the lead")
	}

	// Re-listing shows them adopted; re-adopting is a no-op, not a duplicate.
	list := listLocalAgents(t, b)
	for _, a := range list.Agents {
		if (a.ID == "codex" || a.ID == "gemini") && a.AdoptedAs != a.ID {
			t.Fatalf("%s adopted_as = %q, want %q", a.ID, a.AdoptedAs, a.ID)
		}
	}
	again := adoptLocalAgents(t, b, `{"ids":["gemini"]}`)
	if len(again.Adopted) != 0 || len(again.Skipped) != 1 || !strings.Contains(again.Skipped[0].Reason, "already adopted") {
		t.Fatalf("re-adopt = %+v, want one 'already adopted' skip", again)
	}
}

func TestAdoptLocalAgentExplainsWhyItSkipped(t *testing.T) {
	stubLocalAgentScan(t,
		detectionFor(t, "aider", false, 77),
		detectionFor(t, "openclaw", true),
	)
	b := newTestBroker(t)
	resp := adoptLocalAgents(t, b, `{"ids":["aider","openclaw","nope"]}`)
	if len(resp.Adopted) != 0 || len(resp.Skipped) != 3 {
		t.Fatalf("resp = %+v, want three skips", resp)
	}
	reasons := map[string]string{}
	for _, s := range resp.Skipped {
		reasons[s.ID] = s.Reason
	}
	if !strings.Contains(reasons["aider"], "not installed") {
		t.Fatalf("aider reason = %q", reasons["aider"])
	}
	if !strings.Contains(reasons["openclaw"], "Integrations") {
		t.Fatalf("openclaw reason = %q, want a pointer to the Integrations app", reasons["openclaw"])
	}
	if reasons["nope"] != "unknown agent" {
		t.Fatalf("nope reason = %q", reasons["nope"])
	}
}

func TestAdoptLocalAgentAvoidsSlugCollisions(t *testing.T) {
	stubLocalAgentScan(t, detectionFor(t, "gemini", true))
	b := newTestBroker(t)
	// A hand-made bot already holds the "gemini" slug on another runtime.
	b.mu.Lock()
	b.members = append(b.members, officeMember{Slug: "gemini", Name: "Gem the designer"})
	b.memberIndex["gemini"] = len(b.members) - 1
	b.mu.Unlock()

	resp := adoptLocalAgents(t, b, `{"ids":["gemini"]}`)
	if len(resp.Adopted) != 1 || resp.Adopted[0].Slug != "gemini-agent" {
		t.Fatalf("resp = %+v, want adoption as @gemini-agent", resp)
	}
}

func TestAdoptLocalAgentsRejectsEmptyRequest(t *testing.T) {
	b := newTestBroker(t)
	rec := httptest.NewRecorder()
	b.handleAdoptLocalAgents(rec, httptest.NewRequest(http.MethodPost, "/agents/local/adopt", strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
