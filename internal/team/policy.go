package team

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// officeSignal is an internal audit record used by watchdog monitoring and
// relay event tracking. It is NOT used for policy generation.
type officeSignal struct {
	ID            string
	Source        string
	Kind          string
	Title         string
	Content       string
	Confidence    string
	Urgency       string
	Channel       string
	Owner         string
	RequiresHuman bool
	Blocking      bool
}

// officePolicy is a named operating rule for the office. Policies are always
// single-threaded: one atomic rule per record (core-loop step 11).
// Source is either "human_directed" (explicitly set by the human via message
// or command) or "auto_detected" (compiled from a playbook's ## Rules section
// or otherwise inferred from a recurring working pattern).
type officePolicy struct {
	ID        string `json:"id"`
	Source    string `json:"source"` // "human_directed" | "auto_detected"
	Rule      string `json:"rule"`   // plain-English description of the rule
	Active    bool   `json:"active"`
	CreatedAt string `json:"created_at"`
	// Bots lists the bot slugs this policy is assigned to (core-loop
	// step 8/B3). Empty or nil means the policy applies to ALL bots —
	// today's behavior, preserved for every pre-existing record. Wire
	// shape: additive `bots` key, omitted when empty.
	Bots []string `json:"agents,omitempty"`
}

func newOfficePolicy(source, rule string) officePolicy {
	rule = strings.TrimSpace(rule)
	source = strings.TrimSpace(source)
	if source == "" {
		source = "human_directed"
	}
	return officePolicy{
		ID:        fmt.Sprintf("policy-%d", time.Now().UnixNano()),
		Source:    source,
		Rule:      rule,
		Active:    true,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

// normalizePolicyBots canonicalizes a bot-scope list: trims, drops
// empties, dedupes, and sorts so persisted scope (and the prompt blocks
// derived from it) are deterministic. Returns nil for an effectively-empty
// list, which is the "applies to all bots" representation.
func normalizePolicyBots(bots []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(bots))
	for _, a := range bots {
		slug := strings.ToLower(strings.TrimSpace(a))
		if slug == "" {
			continue
		}
		if _, ok := seen[slug]; ok {
			continue
		}
		seen[slug] = struct{}{}
		out = append(out, slug)
	}
	if len(out) == 0 {
		return nil
	}
	sort.Strings(out)
	return out
}

// policyAppliesToBot reports whether the policy is in force for the given
// bot slug. Nil/empty Bots means everyone (legacy + human-feedback
// default); a non-empty list scopes the policy to exactly those bots.
func policyAppliesToBot(p officePolicy, slug string) bool {
	if len(p.Bots) == 0 {
		return true
	}
	slug = strings.ToLower(strings.TrimSpace(slug))
	for _, a := range p.Bots {
		if a == slug {
			return true
		}
	}
	return false
}

// normalizePolicyRuleText collapses whitespace and lowercases a rule for
// duplicate detection. "Simple normalized-text match" — the policy analogue
// of the skill dedup gate's tier-1 check, deliberately cheap.
func normalizePolicyRuleText(rule string) string {
	return strings.ToLower(strings.Join(strings.Fields(rule), " "))
}
