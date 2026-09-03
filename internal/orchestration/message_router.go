package orchestration

import (
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// atMentionPattern matches @slug patterns in messages.
var atMentionPattern = regexp.MustCompile(`@(\S+)`)

// BotInfo describes an available bot for message routing.
type BotInfo struct {
	Slug      string
	Expertise []string
	RoleTerms []string
}

// MessageRoutingResult is the output of a Route call.
type MessageRoutingResult struct {
	Primary       string // bot slug
	Collaborators []string
	IsFollowUp    bool
	TeamLeadAware bool
}

type threadContext struct {
	botSlug      string
	lastActivity time.Time
}

// MessageRouter routes free-text messages to the most appropriate bot.
type MessageRouter struct {
	router         *TaskRouter
	recentThreads  map[string]*threadContext
	followUpWindow time.Duration
	teamLeadSlug   string
	mu             sync.Mutex
}

// NewMessageRouter returns a MessageRouter with a 30s follow-up window.
func NewMessageRouter() *MessageRouter {
	return &MessageRouter{
		router:         NewTaskRouter(),
		recentThreads:  make(map[string]*threadContext),
		followUpWindow: 30 * time.Second,
	}
}

// SetTeamLeadSlug configures which bot slug acts as the team lead.
func (m *MessageRouter) SetTeamLeadSlug(slug string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.teamLeadSlug = slug
}

// getTeamLeadSlug returns the configured team-lead slug, defaulting to "team-lead".
// Caller must hold m.mu.
func (m *MessageRouter) getTeamLeadSlug() string {
	if m.teamLeadSlug != "" {
		return m.teamLeadSlug
	}
	return "team-lead"
}

// RegisterBot registers a bot's expertise with the underlying TaskRouter.
func (m *MessageRouter) RegisterBot(slug string, expertise []string) {
	skills := make([]SkillDeclaration, len(expertise))
	for i, e := range expertise {
		skills[i] = SkillDeclaration{Name: e, Description: e, Proficiency: 1.0}
	}
	m.router.RegisterBot(slug, skills)
}

// UnregisterBot removes a bot from the message router.
func (m *MessageRouter) UnregisterBot(slug string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.router.UnregisterBot(slug)
	delete(m.recentThreads, slug)
}

// RecordBotActivity marks a bot as recently active.
func (m *MessageRouter) RecordBotActivity(botSlug string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if tc, ok := m.recentThreads[botSlug]; ok {
		tc.lastActivity = time.Now()
	} else {
		m.recentThreads[botSlug] = &threadContext{
			botSlug:      botSlug,
			lastActivity: time.Now(),
		}
	}
}

// Route decides which bot(s) should handle a message.
func (m *MessageRouter) Route(message string, availableBots []BotInfo) MessageRoutingResult {
	m.mu.Lock()
	defer m.mu.Unlock()

	result := MessageRoutingResult{}

	teamLead := m.getTeamLeadSlug()

	// 1. Check for explicit @slug mention — highest priority, outranks follow-up.
	if slug := m.detectAtMention(message, availableBots); slug != "" {
		result.Primary = slug
		result.TeamLeadAware = slug == teamLead
		return result
	}

	// 2. Check follow-up — route to the recently active bot.
	if followUpSlug := m.detectFollowUp(message); followUpSlug != "" {
		result.Primary = followUpSlug
		result.IsFollowUp = true
		result.TeamLeadAware = true
		return result
	}

	// 3. New directive: always route to team-lead first per spec.
	// Still populate collaborators for informational purposes.
	result.Primary = teamLead
	result.TeamLeadAware = true

	result.Collaborators = m.inferCollaborators(message, availableBots, teamLead)
	return result
}

var followUpPattern = regexp.MustCompile(
	`(?i)^(also|and |too |that |it |the results|those |these |this |what about|how about|can you also)`,
)

// detectFollowUp returns the most recently active bot slug if the message
// looks like a follow-up and was within the follow-up window.
func (m *MessageRouter) detectFollowUp(message string) string {
	if !followUpPattern.MatchString(strings.TrimSpace(message)) {
		return ""
	}
	var best *threadContext
	for _, tc := range m.recentThreads {
		if time.Since(tc.lastActivity) <= m.followUpWindow {
			if best == nil || tc.lastActivity.After(best.lastActivity) {
				best = tc
			}
		}
	}
	if best != nil {
		return best.botSlug
	}
	return ""
}

// detectAtMention returns the slug of an explicitly @mentioned bot, if any.
// Caller must hold m.mu.
func (m *MessageRouter) detectAtMention(message string, bots []BotInfo) string {
	matches := atMentionPattern.FindAllStringSubmatch(message, -1)
	if len(matches) == 0 {
		return ""
	}
	known := make(map[string]bool, len(bots))
	for _, a := range bots {
		known[a.Slug] = true
	}
	for _, match := range matches {
		slug := match[1]
		if known[slug] {
			return slug
		}
	}
	return ""
}

// ExtractSkills returns generic routing terms inferred from the message text.
func (m *MessageRouter) ExtractSkills(message string) []string {
	return extractRoutingTerms(message)
}

// ExtractRoutingTerms returns normalized routing terms for arbitrary message text.
func ExtractRoutingTerms(message string) []string {
	return extractRoutingTerms(message)
}

var routingWordPattern = regexp.MustCompile(`[a-z0-9]+`)

var routingStopWords = map[string]struct{}{
	"a": {}, "an": {}, "and": {}, "are": {}, "as": {}, "at": {}, "be": {}, "but": {}, "by": {},
	"can": {}, "could": {}, "do": {}, "for": {}, "from": {}, "have": {}, "help": {}, "i": {},
	"in": {}, "is": {}, "it": {}, "just": {}, "make": {}, "me": {}, "need": {}, "new": {},
	"of": {}, "on": {}, "or": {}, "our": {}, "please": {}, "set": {}, "should": {}, "that": {},
	"the": {}, "their": {}, "then": {}, "there": {}, "this": {}, "to": {}, "up": {}, "us": {}, "want": {},
	"hello": {}, "hi": {}, "hey": {}, "thanks": {}, "thank": {},
	"we": {}, "with": {}, "you": {}, "your": {},
}

func (m *MessageRouter) inferCollaborators(message string, availableBots []BotInfo, teamLead string) []string {
	messageTerms := extractRoutingTerms(message)
	if len(messageTerms) == 0 {
		return nil
	}

	type scoredBot struct {
		slug  string
		score float64
	}

	var scored []scoredBot
	for _, bot := range availableBots {
		if bot.Slug == teamLead {
			continue
		}
		score := scoreBotAgainstMessage(messageTerms, botRoutingTerms(bot))
		if score >= 0.28 {
			scored = append(scored, scoredBot{slug: bot.Slug, score: score})
		}
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].score == scored[j].score {
			return scored[i].slug < scored[j].slug
		}
		return scored[i].score > scored[j].score
	})

	result := make([]string, 0, len(scored))
	for _, item := range scored {
		result = append(result, item.slug)
	}
	return result
}

func botRoutingTerms(bot BotInfo) []string {
	return RoutingTerms(bot.Slug, bot.Expertise, bot.RoleTerms, nil)
}

// BotRoutingTerms returns normalized routing terms for a slug plus its metadata.
func BotRoutingTerms(slug string, expertise []string, roleTerms []string) []string {
	return RoutingTerms(slug, expertise, roleTerms, nil)
}

// RoutingTerms returns normalized routing terms for a routing candidate.
func RoutingTerms(slug string, expertise []string, roleTerms []string, extraTerms []string) []string {
	terms := make([]string, 0, 1+len(expertise)+len(roleTerms)+len(extraTerms))
	terms = append(terms, slug)
	terms = append(terms, expertise...)
	terms = append(terms, roleTerms...)
	terms = append(terms, extraTerms...)
	return dedupeTerms(normalizeRoutingTerms(terms))
}

func scoreBotAgainstMessage(messageTerms, botTerms []string) float64 {
	if len(messageTerms) == 0 || len(botTerms) == 0 {
		return 0
	}

	bestScores := make([]float64, 0, len(messageTerms))
	for _, messageTerm := range messageTerms {
		best := 0.0
		for _, botTerm := range botTerms {
			if score := similarity(messageTerm, botTerm); score > best {
				best = score
			}
		}
		if best >= 0.3 {
			bestScores = append(bestScores, best)
		}
	}

	if len(bestScores) == 0 {
		return 0
	}

	sort.Float64s(bestScores)
	top := 2
	if len(bestScores) < top {
		top = len(bestScores)
	}
	sum := 0.0
	for i := len(bestScores) - top; i < len(bestScores); i++ {
		sum += bestScores[i]
	}
	return sum / float64(top)
}

// ScoreMessageAgainstBot returns the metadata routing score for a message.
func ScoreMessageAgainstBot(message string, slug string, expertise []string, roleTerms []string) float64 {
	return ScoreMessageAgainstTerms(message, BotRoutingTerms(slug, expertise, roleTerms))
}

// ScoreMessageAgainstTerms returns the metadata routing score for message text
// against a precomputed set of routing terms.
func ScoreMessageAgainstTerms(message string, terms []string) float64 {
	return scoreBotAgainstMessage(ExtractRoutingTerms(message), dedupeTerms(normalizeRoutingTerms(terms)))
}

func extractRoutingTerms(message string) []string {
	tokens := normalizeRoutingTerms(routingWordPattern.FindAllString(strings.ToLower(message), -1))
	filtered := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if _, ok := routingStopWords[token]; !ok {
			filtered = append(filtered, token)
		}
	}
	if len(filtered) == 0 {
		return nil
	}

	var out []string
	for size := 1; size <= 3; size++ {
		if len(filtered) < size {
			break
		}
		for i := 0; i+size <= len(filtered); i++ {
			out = append(out, strings.Join(filtered[i:i+size], " "))
		}
	}
	return dedupeTerms(out)
}

func normalizeRoutingTerms(terms []string) []string {
	out := make([]string, 0, len(terms))
	for _, term := range terms {
		normalized := normalizeRoutingTerm(term)
		if normalized != "" {
			out = append(out, normalized)
		}
	}
	return out
}

func normalizeRoutingTerm(term string) string {
	parts := routingWordPattern.FindAllString(strings.ToLower(term), -1)
	if len(parts) == 0 {
		return ""
	}
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if _, ok := routingStopWords[part]; !ok {
			filtered = append(filtered, part)
		}
	}
	if len(filtered) == 0 {
		return ""
	}
	return strings.Join(filtered, " ")
}

func dedupeTerms(terms []string) []string {
	seen := make(map[string]struct{}, len(terms))
	out := make([]string, 0, len(terms))
	for _, term := range terms {
		if _, ok := seen[term]; ok {
			continue
		}
		seen[term] = struct{}{}
		out = append(out, term)
	}
	return out
}
