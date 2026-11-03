package teammcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const localAgentsFixture = `{"lead":"cos","agents":[
 {"id":"claude-code","name":"Claude Code","runtime":"native","installed":true,"adoptable":true,"adopted_as":"claude-code","running":[{"pid":10}]},
 {"id":"gemini","name":"Gemini CLI","runtime":"cli","installed":true,"adoptable":true,"running":[{"pid":11},{"pid":12}]},
 {"id":"aider","name":"Aider","runtime":"cli","installed":false,"adoptable":true,"running":[{"pid":13}]},
 {"id":"cursor","name":"Cursor","runtime":"app","installed":true,"adoptable":false,"note":"IDE with no headless mode."}
]}`

func stubLocalAgentsBroker(t *testing.T, adoptBodies *[]string) {
	t.Helper()
	var auth *testingAuth
	srv, auth := stubBroker(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/agents/local":
			_, _ = w.Write([]byte(localAgentsFixture))
		case r.Method == http.MethodPost && r.URL.Path == "/agents/local/adopt":
			var body struct {
				IDs []string `json:"ids"`
			}
			// stubBroker already drained r.Body into auth.lastBody.
			_ = json.Unmarshal([]byte(auth.lastBody), &body)
			*adoptBodies = append(*adoptBodies, strings.Join(body.IDs, ","))
			_, _ = w.Write([]byte(`{"adopted":[{"id":"gemini","slug":"gemini","name":"Gemini CLI"}]}`))
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusNotFound)
		}
	})
	t.Cleanup(srv.Close)
	withBrokerURL(t, srv.URL)
	t.Setenv("WUPHF_AGENT_SLUG", "cos")
	prev := reconfigureOfficeSessionFn
	reconfigureOfficeSessionFn = func() error { return nil }
	t.Cleanup(func() { reconfigureOfficeSessionFn = prev })
}

func TestTeamLocalAgentsListExplainsEachAgent(t *testing.T) {
	var adopts []string
	stubLocalAgentsBroker(t, &adopts)
	res, _, _ := handleTeamLocalAgents(context.Background(), nil, TeamLocalAgentsArgs{Action: "list"})
	text := toolErrorText(res)
	for _, want := range []string{
		"Claude Code [claude-code] running ×1 — teammate @claude-code",
		"Gemini CLI [gemini] running ×2 — adoptable",
		"Aider [aider] running ×1 — not adoptable: its binary is not on this machine's PATH",
		"Cursor [cursor] — not adoptable: IDE with no headless mode.",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("list output missing %q:\n%s", want, text)
		}
	}
	if len(adopts) != 0 {
		t.Fatal("list must not adopt anything")
	}
}

func TestTeamLocalAgentsAdoptAllSendsOnlyAdoptableIDs(t *testing.T) {
	t.Setenv("WUPHF_UNSAFE", "1") // bypass the approval card; the gate itself is tested in member_approval_test.go
	var adopts []string
	stubLocalAgentsBroker(t, &adopts)
	res, _, _ := handleTeamLocalAgents(context.Background(), nil, TeamLocalAgentsArgs{Action: "adopt", All: true})
	if isToolError(res) {
		t.Fatalf("adopt all failed: %s", toolErrorText(res))
	}
	if len(adopts) != 1 || adopts[0] != "gemini" {
		t.Fatalf("adopt requests = %q, want exactly [gemini]", adopts)
	}
	if !strings.Contains(toolErrorText(res), "Adopted Gemini CLI as @gemini.") {
		t.Fatalf("result = %q", toolErrorText(res))
	}
}

func TestTeamLocalAgentsAdoptRejectsUnadoptableIDs(t *testing.T) {
	t.Setenv("WUPHF_UNSAFE", "1")
	var adopts []string
	stubLocalAgentsBroker(t, &adopts)
	for id, want := range map[string]string{
		"cursor":      "no headless mode",
		"claude-code": "already a teammate",
		"goose":       "not found on this machine",
	} {
		res, _, _ := handleTeamLocalAgents(context.Background(), nil, TeamLocalAgentsArgs{Action: "adopt", IDs: []string{id}})
		if !isToolError(res) || !strings.Contains(toolErrorText(res), want) {
			t.Errorf("adopt %s = %q, want error containing %q", id, toolErrorText(res), want)
		}
	}
	if len(adopts) != 0 {
		t.Fatalf("no adopt request should reach the broker, got %q", adopts)
	}
}

func TestTeamLocalAgentsAdoptRefusesNonLead(t *testing.T) {
	t.Setenv("WUPHF_UNSAFE", "1")
	var adopts []string
	stubLocalAgentsBroker(t, &adopts)
	t.Setenv("WUPHF_AGENT_SLUG", "designer")
	res, _, _ := handleTeamLocalAgents(context.Background(), nil, TeamLocalAgentsArgs{Action: "adopt", All: true})
	if !isToolError(res) || !strings.Contains(toolErrorText(res), "Chief of Staff") {
		t.Fatalf("non-lead adopt = %q, want a Chief of Staff-only error", toolErrorText(res))
	}
	if len(adopts) != 0 {
		t.Fatalf("non-lead adopt reached the broker: %q", adopts)
	}
}

func TestTeamLocalAgentsIsLeadOnly(t *testing.T) {
	if !hasTool(listRegisteredToolsWithSlug(t, "cos", "launch", false), "team_local_agents") {
		t.Fatal("the Chief of Staff should get team_local_agents in office mode")
	}
	if hasTool(listRegisteredToolsWithSlug(t, "designer", "launch", false), "team_local_agents") {
		t.Fatal("specialists must not get team_local_agents")
	}
}
