package team

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/provider"
)

// Local agent adoption: find the agent CLIs on this machine (Claude Code,
// Codex, Opencode, Gemini CLI, Aider, Goose, ...) and turn each into an
// office bot the Chief of Staff routes work to.
//
//	GET  /agents/local        — scan; one entry per agent found on the machine
//	POST /agents/local/adopt  — {"ids":[...]} or {"all":true}
//	GET  /agents/local/sessions — what each running session is about
//
// Owner-only: neither route is on the joined-human allowlist, because the
// scan describes the host machine and adoption grows the roster.

// localAgentScanFn is swapped by tests; production scans the real machine.
var localAgentScanFn = func(ctx context.Context) []agentdetect.Detection {
	return agentdetect.NewScanner().Scan(ctx)
}

// localSessionsFn is swapped by tests; production reads the real machine.
// Each session is named by what it is doing (agentdetect.Sessions), so the
// notch can tell four open Claude Code windows apart.
//
// The production scan also notes which sessions the tools themselves say are
// open (agentdetect.OpenSessions), from the same process listing. It runs
// only from cachedLocalSessions, which holds localSessions.mu, so it writes
// the cache's open fields directly; a test's stub leaves them "unknown".
var localSessionsFn = func(ctx context.Context) []agentdetect.Session {
	scanner := agentdetect.NewScanner()
	scan := scanner.Scan(ctx)
	localSessions.open, localSessions.openKnown = scanner.OpenSessions()
	return scanner.Sessions(scan, time.Now())
}

// localOpenSessionsFn is nil in production; tests set it to say which
// sessions are open (see cachedLocalOpenSessions).
var localOpenSessionsFn func(ctx context.Context) (map[string]agentdetect.OpenSession, bool)

// The notch asks on a timer; the scan lists processes and reads log tails,
// so its answer is kept this long.
const localSessionsTTL = 8 * time.Second

type localSessionsCache struct {
	mu   sync.Mutex
	at   time.Time
	list []agentdetect.Session
	// open are the sessions a tool reports as open right now, by session id;
	// openKnown is false when no tool could be asked.
	open      map[string]agentdetect.OpenSession
	openKnown bool
}

var localSessions localSessionsCache

type localSessionsResponse struct {
	Sessions []agentdetect.Session `json:"sessions"`
}

// handleLocalSessions lists the agent sessions running on this machine,
// each named by what it is about. Owner-only like the rest of this file:
// it describes the host machine and what the human is working on.
func (b *Broker) handleLocalSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, localSessionsResponse{Sessions: cachedLocalSessions(r.Context())})
}

// cachedLocalSessions is the machine's session list, scanned at most once
// per localSessionsTTL. Never nil.
func cachedLocalSessions(ctx context.Context) []agentdetect.Session {
	localSessions.mu.Lock()
	defer localSessions.mu.Unlock()
	if localSessions.list == nil || time.Since(localSessions.at) > localSessionsTTL {
		localSessions.open, localSessions.openKnown = nil, false
		list := localSessionsFn(ctx)
		if localOpenSessionsFn != nil {
			localSessions.open, localSessions.openKnown = localOpenSessionsFn(ctx)
		}
		if list == nil {
			list = []agentdetect.Session{}
		}
		localSessions.list = list
		localSessions.at = time.Now()
	}
	return localSessions.list
}

// cachedLocalOpenSessions is which sessions the tools say are open, as of
// the scan cachedLocalSessions last ran. Call that first.
func cachedLocalOpenSessions() sessionOpenness {
	localSessions.mu.Lock()
	defer localSessions.mu.Unlock()
	return sessionOpenness{known: localSessions.openKnown, open: localSessions.open}
}

type localAgentEntry struct {
	agentdetect.Detection
	// AdoptedAs is the slug of the office bot already running this agent.
	AdoptedAs string `json:"adopted_as,omitempty"`
}

type localAgentsResponse struct {
	Agents []localAgentEntry `json:"agents"`
	// Lead is the Chief of Staff slug adopted bots report to.
	Lead string `json:"lead,omitempty"`
}

type localAgentAdoptBody struct {
	IDs []string `json:"ids"`
	All bool     `json:"all"`
	// Actor is who asked: the Chief of Staff's tool sends its slug; the
	// Settings page sends nothing, which means the human.
	Actor string `json:"actor"`
}

type localAgentAdopted struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type localAgentSkipped struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type localAgentAdoptResponse struct {
	Adopted []localAgentAdopted `json:"adopted"`
	Skipped []localAgentSkipped `json:"skipped,omitempty"`
	Lead    string              `json:"lead,omitempty"`
}

func (b *Broker) handleLocalAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	scan := localAgentScanFn(r.Context())
	b.mu.Lock()
	entries := b.localAgentEntriesLocked(scan)
	lead := officeLeadSlugFrom(b.members)
	b.mu.Unlock()
	writeJSON(w, http.StatusOK, localAgentsResponse{Agents: entries, Lead: lead})
}

// localAgentEntriesLocked keeps only agents actually seen on the machine and
// annotates each with the bot already adopted from it.
func (b *Broker) localAgentEntriesLocked(scan []agentdetect.Detection) []localAgentEntry {
	out := make([]localAgentEntry, 0, len(scan))
	for _, d := range scan {
		if !d.Found() {
			continue
		}
		out = append(out, localAgentEntry{Detection: d, AdoptedAs: b.adoptedSlugForLocked(d.ID)})
	}
	return out
}

// adoptedSlugForLocked returns the member already bound to agent id, or "".
// A member counts when its binding runs this agent and its slug is the one
// adoption would have minted (id, id-agent, id-agent-N). Matching on the
// binding alone would claim an unrelated hand-built bot that merely runs on
// Claude Code as "the adopted Claude Code".
func (b *Broker) adoptedSlugForLocked(id string) string {
	spec, ok := agentdetect.Lookup(id)
	if !ok {
		return ""
	}
	want := adoptionBinding(spec)
	for _, m := range b.members {
		if m.AdoptedFrom == spec.ID {
			return m.Slug
		}
	}
	for _, m := range b.members {
		if !strings.HasPrefix(m.Slug, spec.ID) {
			continue
		}
		rest := strings.TrimPrefix(m.Slug, spec.ID)
		if rest != "" && rest != "-agent" && !strings.HasPrefix(rest, "-agent-") {
			continue
		}
		if bindingRunsAgent(m.Provider, want) {
			return m.Slug
		}
	}
	return ""
}

func adoptionBinding(spec agentdetect.Spec) provider.ProviderBinding {
	if spec.Runtime == agentdetect.RuntimeCLI {
		return provider.ProviderBinding{
			Kind:     provider.KindCLIAgent,
			CLIAgent: &provider.CLIAgentProviderBinding{Agent: spec.ID},
		}
	}
	return provider.ProviderBinding{Kind: spec.ProviderKind}
}

func bindingRunsAgent(have, want provider.ProviderBinding) bool {
	if have.Kind != want.Kind {
		return false
	}
	if want.Kind != provider.KindCLIAgent {
		return true
	}
	return have.CLIAgent != nil && want.CLIAgent != nil && have.CLIAgent.Agent == want.CLIAgent.Agent
}

func (b *Broker) handleAdoptLocalAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body localAgentAdoptBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if !body.All && len(body.IDs) == 0 {
		http.Error(w, "ids or all required", http.StatusBadRequest)
		return
	}

	scan := localAgentScanFn(r.Context())
	byID := make(map[string]agentdetect.Detection, len(scan))
	for _, d := range scan {
		byID[d.ID] = d
	}
	wanted := make([]string, 0, len(body.IDs))
	if body.All {
		for _, d := range scan {
			if d.Adoptable && d.Installed {
				wanted = append(wanted, d.ID)
			}
		}
	} else {
		seen := map[string]bool{}
		for _, raw := range body.IDs {
			id := strings.ToLower(strings.TrimSpace(raw))
			if id != "" && !seen[id] {
				seen[id] = true
				wanted = append(wanted, id)
			}
		}
	}

	b.officeMemberMutationMu.Lock()
	defer b.officeMemberMutationMu.Unlock()

	b.mu.Lock()
	lead := officeLeadSlugFrom(b.members)
	b.mu.Unlock()

	resp := localAgentAdoptResponse{Adopted: []localAgentAdopted{}, Lead: lead}
	for _, id := range wanted {
		d, found := byID[id]
		spec, known := agentdetect.Lookup(id)
		switch {
		case !known:
			resp.Skipped = append(resp.Skipped, localAgentSkipped{ID: id, Reason: "unknown agent"})
			continue
		case !spec.Adoptable():
			resp.Skipped = append(resp.Skipped, localAgentSkipped{ID: id, Reason: firstNonEmpty(spec.Note, spec.Name+" cannot be driven headlessly")})
			continue
		case !found || !d.Installed:
			resp.Skipped = append(resp.Skipped, localAgentSkipped{ID: id, Reason: spec.Name + " is not installed on this machine"})
			continue
		}
		b.mu.Lock()
		existing := b.adoptedSlugForLocked(id)
		slug := b.freeAdoptionSlugLocked(spec.ID)
		b.mu.Unlock()
		if existing != "" {
			resp.Skipped = append(resp.Skipped, localAgentSkipped{ID: id, Reason: "already adopted as @" + existing})
			continue
		}
		if slug == "" {
			resp.Skipped = append(resp.Skipped, localAgentSkipped{ID: id, Reason: "no free bot slug"})
			continue
		}
		member, err := b.adoptLocalAgent(r, slug, spec, body.Actor)
		if err != nil {
			resp.Skipped = append(resp.Skipped, localAgentSkipped{ID: id, Reason: err.Error()})
			continue
		}
		resp.Adopted = append(resp.Adopted, localAgentAdopted{ID: id, Slug: member.Slug, Name: member.Name})
	}

	if len(resp.Adopted) > 0 {
		b.announceAdoptedLocalAgents(lead, resp.Adopted)
	}
	writeJSON(w, http.StatusOK, resp)
}

// freeAdoptionSlugLocked picks id, then id-agent, then id-agent-2..9.
func (b *Broker) freeAdoptionSlugLocked(id string) string {
	candidates := []string{id, id + "-agent"}
	for i := 2; i <= 9; i++ {
		candidates = append(candidates, fmt.Sprintf("%s-agent-%d", id, i))
	}
	for _, c := range candidates {
		if b.findMemberLocked(c) == nil {
			return c
		}
	}
	return ""
}

// adoptLocalAgent creates the office member through the same path the bot
// wizard uses, so channel seeding, persistence and change events match a
// hand-made hire. The caller holds officeMemberMutationMu.
func (b *Broker) adoptLocalAgent(r *http.Request, slug string, spec agentdetect.Spec, actor string) (officeMember, error) {
	binding := adoptionBinding(spec)
	role := spec.Name + " agent"
	if spec.Vendor != "" {
		role = fmt.Sprintf("%s agent (%s), adopted from this machine", spec.Name, spec.Vendor)
	}
	// created_by is whoever pressed adopt; origin says it was adopted;
	// the Chief of Staff manages it either way (managed_by on the roster).
	createdBy := normalizeActorSlug(actor)
	if createdBy == "" {
		createdBy = createdByHumanValue
	}
	body := officeMemberMutationBody{
		Action:      "create",
		Slug:        slug,
		Name:        spec.Name,
		Role:        role,
		Expertise:   append([]string(nil), spec.Expertise...),
		Personality: fmt.Sprintf("The %s install on this machine, working for the Chief of Staff. Takes delegated work, does it, and reports back plainly.", spec.Name),
		CreatedBy:   createdBy,
		Provider:    &binding,
		origin:      OriginAdopted,
		adoptedFrom: spec.ID,
	}
	result, mErr := b.createOfficeMember(r, slug, body)
	if mErr != nil {
		return officeMember{}, fmt.Errorf("%s", mErr.message)
	}
	if err := b.writeBrokerState(result.write); err != nil {
		return officeMember{}, fmt.Errorf("persist broker state: %w", err)
	}
	b.publishOfficeChanges(result.events)
	if result.ensureNotebookDirs {
		b.backfillBotFilesForRoster()
	}
	member, _ := result.payload["member"].(officeMember)
	return member, nil
}

// announceAdoptedLocalAgents tells the human, in the Chief of Staff's home
// channel, which agents just joined and who is managing them.
func (b *Broker) announceAdoptedLocalAgents(lead string, adopted []localAgentAdopted) {
	names := make([]string, 0, len(adopted))
	for _, a := range adopted {
		names = append(names, fmt.Sprintf("@%s (%s)", a.Slug, a.Name))
	}
	b.mu.Lock()
	channel, err := b.homeChannelForLocked(lead)
	b.mu.Unlock()
	if err != nil {
		channel = ""
	}
	manager := "the Chief of Staff"
	if lead != "" {
		manager = "@" + lead
	}
	b.PostSystemMessage(channel,
		fmt.Sprintf("Adopted from this machine: %s. They now work as gawkbots under %s, who routes work to them.",
			strings.Join(names, ", "), manager),
		"agents_adopted",
	)
}
