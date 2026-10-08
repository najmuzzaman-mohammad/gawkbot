package team

import (
	"strings"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/provider"
)

// Member provenance. Two questions the roster has to answer at a glance:
//
//   - WHO made this bot? (origin) — the human, the Chief of Staff, another
//     bot, the office itself (built-ins), an agent adopted from this
//     machine, or a bot imported from an external gateway/transport.
//   - WHERE does it run? (runs_on) — on this machine, or somewhere else
//     (an OpenClaw/Hermes gateway, Slack, a cloud computer).
//
// origin is persisted on create (officeMember.Origin) so it stays true after
// a rename or a runtime switch; rows written before it existed are inferred
// from CreatedBy. runs_on is always derived from the live binding, because a
// runtime switch genuinely moves the bot.

const (
	OriginUser          = "user"
	OriginChiefOfStaff  = "chief_of_staff"
	OriginBot           = "bot"
	OriginBuiltIn       = "built_in"
	OriginAdopted       = "adopted"
	OriginImported      = "imported"
	RunsOnThisMachine   = "this_machine"
	RunsOnElsewhere     = "elsewhere"
	createdByHumanValue = "human"
)

// humanCreatorValues are the CreatedBy spellings that mean "the person at
// the keyboard". The bot wizard sends no created_by at all.
var humanCreatorValues = map[string]bool{"": true, "human": true, "you": true, "user": true}

// officeCreatorValues mark rows the office seeded itself (packs, onboarding).
var officeCreatorValues = map[string]bool{"wuphf": true, "gawkbot": true, "system": true}

// originForCreate is the origin stamped on a member created through the
// HTTP mutation path, from the CreatedBy the caller sent.
func originForCreate(createdBy, lead string) string {
	c := strings.ToLower(strings.TrimSpace(createdBy))
	switch {
	case humanCreatorValues[c]:
		return OriginUser
	case officeCreatorValues[c]:
		return OriginBuiltIn
	case strings.HasPrefix(c, "slack"):
		return OriginImported
	case lead != "" && c == lead:
		return OriginChiefOfStaff
	default:
		return OriginBot
	}
}

// memberOrigin returns the persisted origin, or infers one for rows written
// before origin existed.
func memberOrigin(m officeMember, lead string) string {
	if o := strings.TrimSpace(m.Origin); o != "" {
		return o
	}
	if m.BuiltIn {
		return OriginBuiltIn
	}
	if provider.IsGatewayKind(m.Provider.Kind) {
		return OriginImported
	}
	if m.Provider.Kind == provider.KindCLIAgent {
		return OriginAdopted
	}
	return originForCreate(m.CreatedBy, lead)
}

// memberRunsOn reports where a member's turns execute and a short human
// description of it ("Gemini CLI on this machine", "OpenClaw gateway").
func memberRunsOn(m officeMember) (where, detail string) {
	switch m.Provider.Kind {
	case provider.KindOpenclaw, provider.KindOpenclawHTTP:
		return RunsOnElsewhere, "OpenClaw gateway"
	case provider.KindHermesBot:
		return RunsOnElsewhere, "Hermes gateway"
	case provider.KindSlack:
		return RunsOnElsewhere, "Slack"
	case provider.KindCLIAgent:
		name := "agent CLI"
		if m.Provider.CLIAgent != nil {
			if spec, ok := agentdetect.Lookup(m.Provider.CLIAgent.Agent); ok {
				name = spec.Name
			}
		}
		return RunsOnThisMachine, name + " on this machine"
	}
	if strings.TrimSpace(m.Computer) == computerCloud {
		return RunsOnElsewhere, "cloud computer"
	}
	kind := m.Provider.Kind
	if kind == "" {
		return RunsOnThisMachine, "this machine"
	}
	if spec, ok := agentdetect.Lookup(adoptionIDForKind(kind)); ok {
		return RunsOnThisMachine, spec.Name + " on this machine"
	}
	return RunsOnThisMachine, kind + " on this machine"
}

// adoptionIDForKind maps a native provider kind back to its catalog id.
func adoptionIDForKind(kind string) string {
	for _, s := range agentdetect.Catalog() {
		if s.Runtime == agentdetect.RuntimeNative && s.ProviderKind == kind {
			return s.ID
		}
	}
	return ""
}
