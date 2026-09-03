package bot

// legacyTemplates retains the old built-in bot templates strictly as a
// compatibility fallback. Blueprint-backed startup is the preferred source of
// truth.
//
// Tools name the local builtin toolset (CreateBuiltinTools). A template must
// not name a tool that no bot can resolve: an unresolvable name is a silent
// no-op at runtime, not a graceful degradation.
var legacyTemplates = map[string]BotConfig{
	"seo-agent": {
		Name:          "SEO Analyst",
		Expertise:     []string{"seo", "content-analysis", "keyword-research"},
		Personality:   "Analytical and data-driven...",
		HeartbeatCron: "daily",
		Tools:         []string{"read_file", "grep_search", "glob", "send_message"},
	},
	"lead-gen": {
		Name:          "Lead Generator",
		Expertise:     []string{"prospecting", "enrichment", "outreach"},
		Personality:   "Proactive hunter...",
		HeartbeatCron: "0 */6 * * *",
		Tools:         []string{"read_file", "grep_search", "write_file", "send_message"},
	},
	"enrichment": {
		Name:          "Data Enricher",
		Expertise:     []string{"data-enrichment", "research", "validation"},
		Personality:   "Thorough researcher...",
		HeartbeatCron: "0 */4 * * *",
		Tools:         []string{"read_file", "grep_search", "glob", "write_file", "send_message"},
	},
	"research": {
		Name:          "Research Analyst",
		Expertise:     []string{"market-research", "competitive-analysis", "trend-analysis"},
		Personality:   "Curious and systematic...",
		HeartbeatCron: "daily",
		Tools:         []string{"read_file", "grep_search", "send_message"},
	},
	"customer-success": {
		Name:          "Customer Success",
		Expertise:     []string{"relationship-management", "health-scoring", "renewal-tracking"},
		Personality:   "Empathetic and proactive...",
		HeartbeatCron: "0 */8 * * *",
		Tools:         []string{"read_file", "grep_search", "glob", "send_message"},
	},
	"team-lead": {
		Name:          "Team Lead",
		Expertise:     []string{"general", "research", "analysis", "communication", "planning", "orchestration"},
		Personality:   "You are the Team Lead — the primary interface...",
		HeartbeatCron: "manual",
		Tools:         []string{"read_file", "grep_search", "glob", "write_file", "bash", "send_message"},
	},
	"founding-agent": {
		Name:          "Team Lead",
		Expertise:     []string{"general", "research", "analysis", "communication", "planning", "orchestration"},
		Personality:   "Versatile and proactive...",
		HeartbeatCron: "daily",
		Tools:         []string{"read_file", "grep_search", "glob", "write_file", "bash", "send_message"},
	},
}

// LegacyTemplateNames returns the compatibility template names, sorted by the
// caller if ordering matters.
func LegacyTemplateNames() []string {
	names := make([]string, 0, len(legacyTemplates))
	for name := range legacyTemplates {
		names = append(names, name)
	}
	return names
}

// LookupLegacyTemplate returns a compatibility template by name.
func LookupLegacyTemplate(name string) (BotConfig, bool) {
	cfg, ok := legacyTemplates[name]
	return cfg, ok
}
