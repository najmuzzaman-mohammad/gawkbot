package team

import (
	"fmt"
	"time"
)

// System skills — capabilities the product itself owns.
//
// App building and wiki maintenance used to be dedicated default bots
// (App Builder, Librarian). Both are retired: the capabilities are skills
// every bot carries. The founder's model, verbatim: "app building is a
// default system skill. it is enabled by default for every bot, can be
// disabled but the skill itself cannot be removed from the system. same
// with wiki maintenance."
//
// That model in mechanism:
//
//   - ensureSystemSkillsLocked seeds both skills and re-asserts them on
//     every state load, so they exist in every office — new or legacy —
//     and an archived copy resurrects. There is no way to delete them.
//   - For a system skill OwnerBots is ignored. The effective assignment
//     is the whole roster minus DisabledBots, so every bot — including
//     one hired five minutes from now — carries the skill until a human
//     switches it off for that bot.
//   - enable-for / disable-for flip DisabledBots; archive, reject,
//     whole-skill disable, and delete refuse.
//   - The capability gates in teammcp (register_app / get_app for app
//     building, team_wiki_write / visual_artifact_promote for wiki
//     maintenance) check SystemSkillEnabledFor before acting.

const (
	systemSkillAppBuilding     = "app-building"
	systemSkillWikiMaintenance = "wiki-maintenance"
)

type systemSkillSpec struct {
	name        string
	title       string
	description string
	content     string
}

func systemSkillSpecs() []systemSkillSpec {
	return []systemSkillSpec{
		{
			name:        systemSkillAppBuilding,
			title:       "App building",
			description: "Build and update internal tools (Apps) for the office. A system skill every bot carries.",
			content: "Every bot can build Apps — small internal tools published under the Apps rail.\n\n" +
				"1. Call list_apps first. If a related app exists, improve it (propose_app with app_id) instead of duplicating it.\n" +
				"2. When the human asked for an app (or approved a proposal), scaffold a real Vite/React/TS project in your build directory, build a single self-contained dist/index.html, and publish it with register_app.\n" +
				"3. When you merely notice a repeatable workflow, raise propose_app and keep working — never block on the answer.\n\n" +
				"Builds flow through the host-owned build and publish gates regardless of which bot registers them.",
		},
		{
			name:        systemSkillWikiMaintenance,
			title:       "Wiki maintenance",
			description: "Keep the team wiki current: draft in notebooks, promote for review, write directly only on the human's explicit ask. A system skill every bot carries.",
			content: "Every bot maintains the team wiki.\n\n" +
				"1. Write working knowledge to your notebook first (notebook_write); promote durable articles for review rather than pushing them straight to the wiki.\n" +
				"2. Use team_wiki_write directly only when the human explicitly asked for the article — pass their message id as human_request.\n" +
				"3. Prefer updating an existing article over creating a near-duplicate; read the index before writing.",
		},
	}
}

// ensureSystemSkillsLocked seeds the system skills and re-asserts their
// invariants (System flag, active status) on every load. Idempotent; an
// archived or disabled copy on disk comes back active because a system
// skill cannot be removed. Caller must hold b.mu.
func (b *Broker) ensureSystemSkillsLocked() {
	now := time.Now().UTC().Format(time.RFC3339)
	for _, spec := range systemSkillSpecs() {
		var existing *teamSkill
		for i := range b.skills {
			if skillSlug(b.skills[i].Name) == spec.name {
				existing = &b.skills[i]
				break
			}
		}
		if existing == nil {
			b.skills = append(b.skills, teamSkill{
				ID:          b.allocateSkillIDLocked(spec.name),
				Name:        spec.name,
				Title:       spec.title,
				Description: spec.description,
				Content:     spec.content,
				CreatedBy:   "wuphf",
				Status:      "active",
				System:      true,
				CreatedAt:   now,
				UpdatedAt:   now,
			})
			continue
		}
		existing.System = true
		if existing.Status != "active" {
			existing.Status = "active"
			existing.DisabledFromStatus = ""
			existing.UpdatedAt = now
		}
		if existing.Title == "" {
			existing.Title = spec.title
		}
		if existing.Description == "" {
			existing.Description = spec.description
		}
		if existing.Content == "" {
			existing.Content = spec.content
		}
	}
}

// systemSkillEffectiveOwnersLocked resolves a system skill's assignment:
// the whole roster minus DisabledBots. Caller must hold b.mu.
func (b *Broker) systemSkillEffectiveOwnersLocked(sk *teamSkill) []string {
	disabled := make(map[string]struct{}, len(sk.DisabledBots))
	for _, slug := range sk.DisabledBots {
		disabled[normalizeActorSlug(slug)] = struct{}{}
	}
	owners := make([]string, 0, len(b.members))
	for _, member := range b.members {
		if _, off := disabled[member.Slug]; off {
			continue
		}
		owners = append(owners, member.Slug)
	}
	return owners
}

// SystemSkillEnabledFor reports whether the named system skill is enabled
// for the bot. A missing skill record reads as enabled — the gate exists
// to honor an explicit per-bot switch-off, and a broken skills read must
// never brick every bot's core capabilities.
func (b *Broker) SystemSkillEnabledFor(skillName, bot string) bool {
	bot = normalizeActorSlug(bot)
	if bot == "" {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := range b.skills {
		sk := &b.skills[i]
		if !sk.System || skillSlug(sk.Name) != skillSlug(skillName) {
			continue
		}
		for _, off := range sk.DisabledBots {
			if normalizeActorSlug(off) == bot {
				return false
			}
		}
		return true
	}
	return true
}

// guardSystemSkillMutation returns a non-empty refusal when the requested
// verb would remove or globally silence a system skill.
func guardSystemSkillMutation(sk *teamSkill, verb string) string {
	if sk == nil || !sk.System {
		return ""
	}
	switch verb {
	case "archive", "reject", "delete", "disable":
		return fmt.Sprintf("%s is a system skill: it cannot be %sd. Disable it per bot with /skills/{name}/disable-for instead.", sk.Name, verb)
	}
	return ""
}
