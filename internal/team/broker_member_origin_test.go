package team

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/provider"
)

func TestMemberOriginInference(t *testing.T) {
	const lead = "cos"
	cases := []struct {
		name string
		m    officeMember
		want string
	}{
		{"persisted wins", officeMember{Origin: OriginAdopted, CreatedBy: "human"}, OriginAdopted},
		{"built-in", officeMember{Slug: "cos", BuiltIn: true}, OriginBuiltIn},
		{"wizard sends no created_by", officeMember{Slug: "designer"}, OriginUser},
		{"human", officeMember{CreatedBy: "human"}, OriginUser},
		{"pack seed", officeMember{CreatedBy: "wuphf"}, OriginBuiltIn},
		{"hired by the lead", officeMember{CreatedBy: "cos"}, OriginChiefOfStaff},
		{"hired by another bot", officeMember{CreatedBy: "eng"}, OriginBot},
		{"slack spawn", officeMember{CreatedBy: "slack-spawn"}, OriginImported},
		{"openclaw import", officeMember{Provider: provider.ProviderBinding{Kind: provider.KindOpenclaw}}, OriginImported},
		{"legacy cli-agent", officeMember{Provider: provider.ProviderBinding{Kind: provider.KindCLIAgent}}, OriginAdopted},
	}
	for _, tc := range cases {
		if got := memberOrigin(tc.m, lead); got != tc.want {
			t.Errorf("%s: origin = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestMemberRunsOn(t *testing.T) {
	cases := []struct {
		m          officeMember
		where, sub string
	}{
		{officeMember{}, RunsOnThisMachine, "this machine"},
		{officeMember{Provider: provider.ProviderBinding{Kind: provider.KindCodex}}, RunsOnThisMachine, "Codex CLI on this machine"},
		{officeMember{Provider: provider.ProviderBinding{Kind: provider.KindCLIAgent, CLIAgent: &provider.CLIAgentProviderBinding{Agent: "gemini"}}}, RunsOnThisMachine, "Gemini CLI"},
		{officeMember{Provider: provider.ProviderBinding{Kind: provider.KindOpenclaw}}, RunsOnElsewhere, "OpenClaw"},
		{officeMember{Provider: provider.ProviderBinding{Kind: provider.KindHermesBot}}, RunsOnElsewhere, "Hermes"},
		{officeMember{Provider: provider.ProviderBinding{Kind: provider.KindSlack}}, RunsOnElsewhere, "Slack"},
		{officeMember{Computer: computerCloud}, RunsOnElsewhere, "cloud computer"},
	}
	for _, tc := range cases {
		where, detail := memberRunsOn(tc.m)
		if where != tc.where || !strings.Contains(detail, tc.sub) {
			t.Errorf("runsOn(%+v) = %q/%q, want %q/~%q", tc.m.Provider, where, detail, tc.where, tc.sub)
		}
	}
}

func TestOfficeMembersListCarriesProvenance(t *testing.T) {
	b := newTestBroker(t)
	post := func(body string) {
		t.Helper()
		rec := httptest.NewRecorder()
		b.handleOfficeMembers(rec, httptest.NewRequest(http.MethodPost, "/office-members", strings.NewReader(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
		}
	}
	post(`{"action":"create","slug":"designer","name":"Designer"}`)
	post(`{"action":"create","slug":"scout","name":"Scout","created_by":"cos"}`)

	rec := httptest.NewRecorder()
	b.handleOfficeMembers(rec, httptest.NewRequest(http.MethodGet, "/office-members", nil))
	var resp struct {
		Members []struct {
			Slug      string `json:"slug"`
			Origin    string `json:"origin"`
			RunsOn    string `json:"runs_on"`
			ManagedBy string `json:"managed_by"`
		} `json:"members"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	lead := b.OfficeLeadSlug()
	got := map[string]string{}
	for _, m := range resp.Members {
		got[m.Slug] = m.Origin + "|" + m.RunsOn + "|" + m.ManagedBy
	}
	if got["designer"] != OriginUser+"|"+RunsOnThisMachine+"|"+lead {
		t.Errorf("designer = %q", got["designer"])
	}
	if got["scout"] != OriginChiefOfStaff+"|"+RunsOnThisMachine+"|"+lead {
		t.Errorf("scout = %q", got["scout"])
	}
	if !strings.HasPrefix(got[lead], OriginBuiltIn+"|") || strings.HasSuffix(got[lead], "|"+lead) {
		t.Errorf("lead = %q, want built_in and not managed by itself", got[lead])
	}
}

func TestOriginCannotBeSetOverHTTP(t *testing.T) {
	b := newTestBroker(t)
	rec := httptest.NewRecorder()
	b.handleOfficeMembers(rec, httptest.NewRequest(http.MethodPost, "/office-members",
		strings.NewReader(`{"action":"create","slug":"spoof","origin":"built_in","adopted_from":"codex"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	m := b.findMemberLocked("spoof")
	if m.Origin != OriginUser || m.AdoptedFrom != "" {
		t.Fatalf("origin=%q adopted_from=%q, want a user-created member", m.Origin, m.AdoptedFrom)
	}
}
