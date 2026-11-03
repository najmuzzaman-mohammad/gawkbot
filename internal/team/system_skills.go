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
	systemSkillDataModeling    = "data-modeling"
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
				"2. When the human asked for an app (or approved a proposal), create the task FIRST: team_task action=create, title \"Build app: <Name>\", owner yourself. The reply carries \"App workspace ready: … as `app_…`\" with the ABSOLUTE path of a project the broker already scaffolded for you (Vite/React/TS, bun.lock committed, src/wuphf-bridge.ts for office data). Work in THAT directory — never scaffold from scratch, never build in /tmp.\n" +
				"3. Implement in src/, then `bun install && bun run verify` there (tsc, then vite build → dist/index.html). Fix errors until it passes.\n" +
				"4. Publish with register_app(app_id=<the id from the brief>, html_path=<absolute path to dist/index.html>, source_path=<absolute project root>). Then tell the human it is live under Apps and complete the task. Keep the whole build to a handful of tool calls — your turn budget is finite.\n" +
				"5. When you merely notice a repeatable workflow, raise propose_app and keep working — never block on the answer.\n\n" +
				"Builds flow through the host-owned build and publish gates regardless of which bot registers them.\n\n" +
				"Data the human should be able to browse and edit under Data belongs in a data space (the data_* tools, the data-modeling system skill), not in the app's per-app db tables; the per-app db stays for values only that app derives and renders.",
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
		{
			name:        systemSkillDataModeling,
			title:       "Data modeling",
			description: "Define object types, attributes and relationships in a data space, then fill them with records. A system skill every bot carries.",
			content: "When the human asks you to TRACK something — investors, clients, projects, candidates, deliverables — that is structured data. Build the model with the data_* tools; do not keep it in prose, and do not reach for an app unless they ask for one.\n\n" +
				"1. Call data_list_spaces, then data_get_schema on the space that fits. One space per use case. If none fits, data_create_space — it is private to you and the human by default.\n" +
				"2. Check the existing types before creating. If a type already exists, add to it with data_add_attributes; never create a second near-duplicate type.\n" +
				"3. Create the types, their attributes AND the relationships between them in ONE data_create_object_types call. A relationship IS an attribute: type=relationship plus `relationship` also creates the mirrored attribute on the other type. State cardinality from the side you are defining, because it cannot be changed later.\n" +
				"4. Re-read the schema right after any create or change: the store adds a required primary `name` attribute you did not define and mints your select option ids, so your own call is NOT the effective schema. Never invent an attribute slug or an option value — an invalid option comes back listing the valid ones. Never add a near-duplicate option; map onto the existing one or ask.\n" +
				"5. Write records with data_upsert_records on a UNIQUE attribute whenever the source could be read again, so a second run updates instead of duplicating. Every write returns {succeeded, failed, summary, entries[]} in request order — read `entries`, do not assume the whole call worked.\n" +
				"6. Deleting is two calls: data_delete_preview, show the human the impact counts, then data_delete with the token. Sharing is the human's call: a space goes shared or global only when they ask.",
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
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.systemSkillEnabledForLocked(skillName, bot)
}

// systemSkillEnabledForLocked is SystemSkillEnabledFor for callers already
// holding b.mu.
func (b *Broker) systemSkillEnabledForLocked(skillName, bot string) bool {
	bot = normalizeActorSlug(bot)
	if bot == "" {
		return true
	}
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
