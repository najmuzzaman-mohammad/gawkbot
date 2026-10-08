package teammcp

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// TeamLocalAgentsArgs drives team_local_agents, the Chief of Staff's view of
// the agent CLIs installed and running on the human's machine.
type TeamLocalAgentsArgs struct {
	Action string   `json:"action" jsonschema:"One of: list, adopt. list shows every agent CLI found on this machine (Claude Code, Codex, Opencode, Gemini CLI, Aider, Goose, ...), whether it is running, and whether it is already a teammate. adopt turns the named agents into office bots that you manage; it always asks the human first."`
	IDs    []string `json:"ids,omitempty" jsonschema:"For adopt: agent ids from list (e.g. gemini, aider, codex)."`
	All    bool     `json:"all,omitempty" jsonschema:"For adopt: adopt every installed agent that can be adopted and is not a teammate yet."`
	MySlug string   `json:"my_slug,omitempty" jsonschema:"Your bot slug. Defaults to WUPHF_AGENT_SLUG."`
}

type localAgentProcess struct {
	PID int    `json:"pid"`
	Cwd string `json:"cwd,omitempty"`
}

type localAgent struct {
	ID        string              `json:"id"`
	Name      string              `json:"name"`
	Vendor    string              `json:"vendor,omitempty"`
	Runtime   string              `json:"runtime"`
	Installed bool                `json:"installed"`
	Running   []localAgentProcess `json:"running,omitempty"`
	Adoptable bool                `json:"adoptable"`
	AdoptedAs string              `json:"adopted_as,omitempty"`
	Note      string              `json:"note,omitempty"`
}

type localAgentsList struct {
	Agents []localAgent `json:"agents"`
	Lead   string       `json:"lead,omitempty"`
}

type localAgentsAdoptResult struct {
	Adopted []struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"adopted"`
	Skipped []struct {
		ID     string `json:"id"`
		Reason string `json:"reason"`
	} `json:"skipped"`
}

func (a localAgent) canAdoptNow() bool {
	return a.Adoptable && a.Installed && a.AdoptedAs == ""
}

func handleTeamLocalAgents(ctx context.Context, _ *mcp.CallToolRequest, args TeamLocalAgentsArgs) (*mcp.CallToolResult, any, error) {
	actor, err := resolveSlug(args.MySlug)
	if err != nil {
		return toolError(err), nil, nil
	}
	var list localAgentsList
	if err := brokerGetJSON(ctx, "/agents/local", &list); err != nil {
		return toolError(err), nil, nil
	}
	switch strings.ToLower(strings.TrimSpace(args.Action)) {
	case "", "list":
		return textResult(formatLocalAgents(list)), nil, nil
	case "adopt":
		if list.Lead != "" && actor != list.Lead {
			return toolError(fmt.Errorf("only the Chief of Staff (@%s) can adopt agents; ask them to do it", list.Lead)), nil, nil
		}
	default:
		return toolError(fmt.Errorf("unknown action %q (use list or adopt)", args.Action)), nil, nil
	}

	// Resolve the request to explicit ids BEFORE asking, so the human
	// approves exactly the agents that will be adopted — "all" cannot grow
	// to include an agent installed after the card was shown.
	byID := make(map[string]localAgent, len(list.Agents))
	for _, a := range list.Agents {
		byID[a.ID] = a
	}
	var targets []localAgent
	if args.All {
		for _, a := range list.Agents {
			if a.canAdoptNow() {
				targets = append(targets, a)
			}
		}
	} else {
		for _, raw := range args.IDs {
			id := strings.ToLower(strings.TrimSpace(raw))
			a, ok := byID[id]
			if !ok {
				return toolError(fmt.Errorf("%q was not found on this machine; call team_local_agents action=list first", raw)), nil, nil
			}
			if !a.canAdoptNow() {
				return toolError(fmt.Errorf("%s cannot be adopted: %s", a.Name, localAgentBlocker(a))), nil, nil
			}
			targets = append(targets, a)
		}
	}
	if len(targets) == 0 {
		return textResult("No agents on this machine are waiting to be adopted.\n\n" + formatLocalAgents(list)), nil, nil
	}

	ids := make([]string, 0, len(targets))
	names := make([]string, 0, len(targets))
	ctxLines := []string{fmt.Sprintf("@%s wants to adopt agents installed on this machine as office bots it manages:", actor)}
	for _, a := range targets {
		ids = append(ids, a.ID)
		names = append(names, a.Name)
		line := fmt.Sprintf("- %s (%s)", a.Name, a.ID)
		if len(a.Running) > 0 {
			line += fmt.Sprintf(", %d running", len(a.Running))
		}
		ctxLines = append(ctxLines, line)
	}
	ctxLines = append(ctxLines, "Each becomes a teammate on its own CLI and sign-in. Rejecting leaves the roster unchanged.")
	sorted := append([]string(nil), ids...)
	sort.Strings(sorted)
	if err := requireHumanCreateApproval(ctx, createApproval{
		Actor:     actor,
		Subject:   strings.Join(names, ", "),
		Title:     fmt.Sprintf("Adopt %d agent(s) from this machine?", len(targets)),
		Question:  fmt.Sprintf("Turn %s into gawkbots managed by @%s?", strings.Join(names, ", "), actor),
		Context:   ctxLines,
		DedupeKey: "local-agents-adopt:" + strings.Join(sorted, ","),
		Guidance:  "keep routing work to the existing roster",
	}); err != nil {
		return toolError(err), nil, nil
	}

	var result localAgentsAdoptResult
	if err := brokerPostJSON(ctx, "/agents/local/adopt", map[string]any{"ids": ids, "actor": actor}, &result); err != nil {
		return toolError(err), nil, nil
	}
	var b strings.Builder
	for _, a := range result.Adopted {
		fmt.Fprintf(&b, "Adopted %s as @%s.\n", a.Name, a.Slug)
	}
	for _, s := range result.Skipped {
		fmt.Fprintf(&b, "Skipped %s: %s\n", s.ID, s.Reason)
	}
	if len(result.Adopted) > 0 {
		b.WriteString("Delegate to them by @mention like any teammate. They run headless without office tools, so give each a self-contained ask and relay their answer.")
	}
	return textResult(strings.TrimSpace(b.String()) + reconfigureOfficeSessionWarning("local_agents_adopt")), nil, nil
}

func localAgentBlocker(a localAgent) string {
	switch {
	case a.AdoptedAs != "":
		return "already a teammate as @" + a.AdoptedAs
	case !a.Adoptable:
		if a.Note != "" {
			return a.Note
		}
		return "it has no headless mode gawkbot can drive"
	case !a.Installed:
		return "its binary is not on this machine's PATH"
	}
	return "unknown"
}

func formatLocalAgents(list localAgentsList) string {
	if len(list.Agents) == 0 {
		return "No agent CLIs found on this machine."
	}
	var b strings.Builder
	b.WriteString("Agents on this machine:\n")
	for _, a := range list.Agents {
		fmt.Fprintf(&b, "- %s [%s]", a.Name, a.ID)
		if len(a.Running) > 0 {
			fmt.Fprintf(&b, " running ×%d", len(a.Running))
		}
		switch {
		case a.AdoptedAs != "":
			fmt.Fprintf(&b, " — teammate @%s", a.AdoptedAs)
		case a.canAdoptNow():
			b.WriteString(" — adoptable")
		default:
			b.WriteString(" — not adoptable: " + localAgentBlocker(a))
		}
		b.WriteByte('\n')
	}
	return strings.TrimSpace(b.String())
}
