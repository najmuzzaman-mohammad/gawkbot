package orchestration

import "sync"

type botUsage struct {
	TokensUsed int
	CostUsd    float64
}

// GlobalUsage aggregates usage across all bots.
type GlobalUsage struct {
	Tokens        int
	Cost          float64
	PercentTokens float64
	PercentCost   float64
}

// BudgetTracker records token and cost usage per bot against a global budget.
type BudgetTracker struct {
	globalBudget BudgetLimit
	usage        map[string]*botUsage
	mu           sync.Mutex
}

// NewBudgetTracker returns a BudgetTracker enforcing globalBudget.
func NewBudgetTracker(globalBudget BudgetLimit) *BudgetTracker {
	return &BudgetTracker{
		globalBudget: globalBudget,
		usage:        make(map[string]*botUsage),
	}
}

// Record adds tokens and cost to a bot's running totals.
func (b *BudgetTracker) Record(botSlug string, tokens int, costUsd float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	u := b.getOrCreate(botSlug)
	u.TokensUsed += tokens
	u.CostUsd += costUsd
}

// GetSnapshot returns the current budget state for botSlug.
func (b *BudgetTracker) GetSnapshot(botSlug string) BudgetSnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()

	u := b.getOrCreate(botSlug)
	snap := BudgetSnapshot{
		BotSlug:     botSlug,
		TokensUsed:  u.TokensUsed,
		CostUsd:     u.CostUsd,
		BudgetLimit: b.globalBudget,
	}

	if b.globalBudget.MaxTokens > 0 {
		snap.PercentUsed = float64(u.TokensUsed) / float64(b.globalBudget.MaxTokens)
	} else if b.globalBudget.MaxCostUsd > 0 {
		snap.PercentUsed = u.CostUsd / b.globalBudget.MaxCostUsd
	}

	snap.Warning = snap.PercentUsed > 0.8
	snap.Exceeded = snap.PercentUsed > 1.0
	return snap
}

// GetAllSnapshots returns snapshots for every tracked bot.
func (b *BudgetTracker) GetAllSnapshots() []BudgetSnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	snaps := make([]BudgetSnapshot, 0, len(b.usage))
	for slug, u := range b.usage {
		snap := BudgetSnapshot{
			BotSlug:     slug,
			TokensUsed:  u.TokensUsed,
			CostUsd:     u.CostUsd,
			BudgetLimit: b.globalBudget,
		}
		if b.globalBudget.MaxTokens > 0 {
			snap.PercentUsed = float64(u.TokensUsed) / float64(b.globalBudget.MaxTokens)
		} else if b.globalBudget.MaxCostUsd > 0 {
			snap.PercentUsed = u.CostUsd / b.globalBudget.MaxCostUsd
		}
		snap.Warning = snap.PercentUsed > 0.8
		snap.Exceeded = snap.PercentUsed > 1.0
		snaps = append(snaps, snap)
	}
	return snaps
}

// CanProceed returns true when the bot has not exceeded its budget.
func (b *BudgetTracker) CanProceed(botSlug string) bool {
	return !b.GetSnapshot(botSlug).Exceeded
}

// IsWarning returns true when the bot is above the 80% warning threshold.
func (b *BudgetTracker) IsWarning(botSlug string) bool {
	return b.GetSnapshot(botSlug).Warning
}

// Reset clears usage data for the given bot.
func (b *BudgetTracker) Reset(botSlug string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.usage, botSlug)
}

// GetGlobalUsage returns the aggregate across all bots.
func (b *BudgetTracker) GetGlobalUsage() GlobalUsage {
	b.mu.Lock()
	defer b.mu.Unlock()

	g := GlobalUsage{}
	for _, u := range b.usage {
		g.Tokens += u.TokensUsed
		g.Cost += u.CostUsd
	}
	if b.globalBudget.MaxTokens > 0 {
		g.PercentTokens = float64(g.Tokens) / float64(b.globalBudget.MaxTokens)
	}
	if b.globalBudget.MaxCostUsd > 0 {
		g.PercentCost = g.Cost / b.globalBudget.MaxCostUsd
	}
	return g
}

// getOrCreate returns the usage record for botSlug, creating it if needed.
// Must be called with mu held.
func (b *BudgetTracker) getOrCreate(botSlug string) *botUsage {
	if u, ok := b.usage[botSlug]; ok {
		return u
	}
	u := &botUsage{}
	b.usage[botSlug] = u
	return u
}
