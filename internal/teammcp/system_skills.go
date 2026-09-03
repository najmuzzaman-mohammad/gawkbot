package teammcp

import (
	"context"
	"fmt"
	"strings"
)

// System-skill gates. App building and wiki maintenance are system skills:
// always present, enabled for every bot by default, and disableable per
// bot from the Skills tab (internal/team/system_skills.go). The MCP tools
// that exercise those capabilities check the switch before acting.

const (
	systemSkillAppBuilding     = "app-building"
	systemSkillWikiMaintenance = "wiki-maintenance"
)

// systemSkillEnabledFor reads the broker's skill list and honors a per-bot
// switch-off on the named system skill. Fail-open on every error path: the
// gate exists to honor an explicit disable, and a broken skills read must
// never brick a bot's core capabilities.
func systemSkillEnabledFor(ctx context.Context, skillName, bot string) bool {
	bot = strings.TrimSpace(strings.ToLower(bot))
	if bot == "" {
		return true
	}
	var resp struct {
		Skills []struct {
			Name         string   `json:"name"`
			System       bool     `json:"system"`
			DisabledBots []string `json:"disabled_agents"`
		} `json:"skills"`
	}
	if err := brokerGetJSON(ctx, "/skills", &resp); err != nil {
		return true
	}
	for _, sk := range resp.Skills {
		if !sk.System || !strings.EqualFold(strings.TrimSpace(sk.Name), skillName) {
			continue
		}
		for _, off := range sk.DisabledBots {
			if strings.EqualFold(strings.TrimSpace(off), bot) {
				return false
			}
		}
		return true
	}
	return true
}

// systemSkillDisabledError is the uniform refusal a gated tool returns.
func systemSkillDisabledError(skillName, bot string) error {
	return fmt.Errorf(
		"the %s system skill is disabled for @%s. Ask the human to re-enable it from the Skills tab (POST /skills/%s/enable-for) if this work is yours to do",
		skillName, bot, skillName,
	)
}
