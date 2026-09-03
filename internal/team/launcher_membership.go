package team

// launcher_membership.go owns the office membership snapshot helpers
// (PLAN.md §C14). officeMembersSnapshot is the canonical roster
// builder used by both targeter wiring and prompt construction;
// botConfigFromMember is the pure transform from the broker member
// shape to the bot.BotConfig shape; botActiveTask resolves the
// "what is this slug currently working on?" task; PackName /
// BotCount / activeSessionMembers / officeMemberBySlug are
// straightforward accessors used by the channel TUI and tests.

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/nex-crm/wuphf/internal/bot"
	"github.com/nex-crm/wuphf/internal/company"
)

// brokerMemberProviderKind reads the per-member provider override from the
// broker, or "" when no broker is wired or no override is set.
func (l *Launcher) brokerMemberProviderKind(slug string) string {
	if l == nil || l.broker == nil {
		return ""
	}
	return l.broker.MemberProviderKind(slug)
}

// botActiveTask returns the first in_progress task owned by the given bot slug.
// AllTasks() is used so bots working in non-general channels still get their
// worktree set up correctly.
func (l *Launcher) botActiveTask(slug string) *teamTask {
	if l.broker == nil {
		return nil
	}
	tasks := l.broker.AllTasks()
	for i := range tasks {
		if tasks[i].Owner == slug && tasks[i].Status() == "in_progress" {
			return &tasks[i]
		}
	}
	return nil
}

func (l *Launcher) officeMembersSnapshot() []officeMember {
	mergePackMembers := func(members []officeMember) []officeMember {
		if l == nil || l.pack == nil || len(l.pack.Bots) == 0 {
			return members
		}
		bySlug := make(map[string]struct{}, len(members))
		for _, member := range members {
			bySlug[member.Slug] = struct{}{}
		}
		for _, cfg := range l.pack.Bots {
			if _, ok := bySlug[cfg.Slug]; ok {
				continue
			}
			member := officeMember{
				Slug:         cfg.Slug,
				Name:         cfg.Name,
				Role:         cfg.Name,
				Expertise:    append([]string(nil), cfg.Expertise...),
				Personality:  cfg.Personality,
				AllowedTools: append([]string(nil), cfg.AllowedTools...),
				BuiltIn:      cfg.Slug == l.pack.LeadSlug || cfg.Slug == "ceo",
			}
			applyOfficeMemberDefaults(&member)
			members = append(members, member)
		}
		return members
	}
	if l.broker != nil {
		if members := l.broker.OfficeMembers(); len(members) > 0 {
			return mergePackMembers(members)
		}
	}
	path := defaultBrokerStatePath()
	data, err := os.ReadFile(path)
	if err == nil {
		var state brokerState
		if json.Unmarshal(data, &state) == nil && len(state.Members) > 0 {
			for i := range state.Members {
				applyOfficeMemberDefaults(&state.Members[i])
			}
			return state.Members
		}
	}
	if l.pack != nil && len(l.pack.Bots) > 0 {
		members := make([]officeMember, 0, len(l.pack.Bots))
		for _, cfg := range l.pack.Bots {
			member := officeMember{
				Slug:         cfg.Slug,
				Name:         cfg.Name,
				Role:         cfg.Name,
				Expertise:    append([]string(nil), cfg.Expertise...),
				Personality:  cfg.Personality,
				AllowedTools: append([]string(nil), cfg.AllowedTools...),
				BuiltIn:      cfg.Slug == l.pack.LeadSlug || cfg.Slug == "ceo",
			}
			applyOfficeMemberDefaults(&member)
			members = append(members, member)
		}
		return mergePackMembers(members)
	}
	if manifest, err := company.LoadRuntimeManifest(resolveRepoRoot(l.cwd)); err == nil && len(manifest.Members) > 0 {
		members := make([]officeMember, 0, len(manifest.Members))
		for _, cfg := range manifest.Members {
			member := officeMember{
				Slug:         cfg.Slug,
				Name:         cfg.Name,
				Role:         cfg.Role,
				Expertise:    append([]string(nil), cfg.Expertise...),
				Personality:  cfg.Personality,
				AllowedTools: append([]string(nil), cfg.AllowedTools...),
				BuiltIn:      cfg.System,
			}
			applyOfficeMemberDefaults(&member)
			members = append(members, member)
		}
		return mergePackMembers(members)
	}
	return mergePackMembers(defaultOfficeMembers())
}

func (l *Launcher) isFocusModeEnabled() bool {
	if l != nil && l.broker != nil {
		return l.broker.FocusModeEnabled()
	}
	if l == nil {
		return false
	}
	return l.focusMode
}

// officeMemberBySlug / officeLeadSlug / activeSessionMembers / getBotName
// live on officeTargeter (PLAN.md §C2); thin wrappers keep current callers
// working without a rename sweep.
func (l *Launcher) officeMemberBySlug(slug string) officeMember {
	return l.targeter().MemberBySlug(slug)
}

func botConfigFromMember(member officeMember) bot.BotConfig {
	cfg := bot.BotConfig{
		Slug:         member.Slug,
		Name:         member.Name,
		Expertise:    append([]string(nil), member.Expertise...),
		Personality:  member.Personality,
		AllowedTools: append([]string(nil), member.AllowedTools...),
	}
	if cfg.Name == "" {
		cfg.Name = humanizeSlug(member.Slug)
	}
	if len(cfg.Expertise) == 0 {
		cfg.Expertise = inferOfficeExpertise(member.Slug, member.Role)
	}
	if cfg.Personality == "" {
		cfg.Personality = inferOfficePersonality(member.Slug, member.Role)
	}
	return cfg
}

func (l *Launcher) activeSessionMembers() []officeMember {
	return l.targeter().ActiveSessionMembers()
}

// PackName returns the display name of the pack.
func (l *Launcher) PackName() string {
	if l.isOneOnOne() {
		return "1:1 with " + l.targeter().NameFor(l.oneOnOneBot())
	}
	return "WUPHF Office"
}

// BotCount returns the number of bots in the pack.
func (l *Launcher) BotCount() int {
	if l.isOneOnOne() {
		return 1
	}
	return len(l.officeMembersSnapshot())
}

// filterEnv returns env with the given key removed.
func filterEnv(env []string, key string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if !strings.HasPrefix(kv, prefix) {
			out = append(out, kv)
		}
	}
	return out
}

// recordPaneSpawnFailure marks a slug so botPaneTargets() omits it and the
// pane-capture loops never try to read from a non-existent target. The bot
// still receives messages via the headless dispatch fallback.
func (l *Launcher) recordPaneSpawnFailure(slug, reason string) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return
	}
	l.failedPaneMu.Lock()
	defer l.failedPaneMu.Unlock()
	if l.failedPaneSlugs == nil {
		l.failedPaneSlugs = make(map[string]string)
	}
	l.failedPaneSlugs[slug] = reason
}

// isFailedPaneSlug reports whether the slug previously failed to
// spawn its tmux pane. Read under failedPaneMu so concurrent writes
// from recordPaneSpawnFailure don't tear the map. Wired into
// officeTargeter as the failedPaneSlugs callback so the targeter's
// routing checks share the same locked view.
func (l *Launcher) isFailedPaneSlug(slug string) bool {
	if l == nil {
		return false
	}
	l.failedPaneMu.RLock()
	defer l.failedPaneMu.RUnlock()
	_, ok := l.failedPaneSlugs[slug]
	return ok
}
