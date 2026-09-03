package bot

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// CredibilityRecord tracks success/failure counts for a single bot.
type CredibilityRecord struct {
	Successes int `json:"successes"`
	Failures  int `json:"failures"`
}

// CredibilityTracker persists per-bot credibility scores to disk.
type CredibilityTracker struct {
	baseDir  string
	filePath string
	data     map[string]CredibilityRecord
	mu       sync.Mutex
}

// NewCredibilityTracker creates a tracker that stores scores at baseDir/scores.json.
// Existing data is loaded from disk if the file exists.
func NewCredibilityTracker(baseDir string) *CredibilityTracker {
	t := &CredibilityTracker{
		baseDir:  baseDir,
		filePath: filepath.Join(baseDir, "scores.json"),
		data:     make(map[string]CredibilityRecord),
	}
	t.load()
	return t
}

func (t *CredibilityTracker) load() {
	b, err := os.ReadFile(t.filePath)
	if err != nil {
		return // file doesn't exist yet; start empty
	}
	_ = json.Unmarshal(b, &t.data)
}

func (t *CredibilityTracker) save() error {
	if err := os.MkdirAll(t.baseDir, 0755); err != nil {
		return fmt.Errorf("create credibility dir: %w", err)
	}
	b, err := json.Marshal(t.data)
	if err != nil {
		return fmt.Errorf("marshal credibility data: %w", err)
	}
	return os.WriteFile(t.filePath, b, 0644)
}

// GetCredibility returns the credibility score [0,1] for the given bot.
// Returns 0.5 if no data exists (neutral default).
func (t *CredibilityTracker) GetCredibility(botSlug string) float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.data[botSlug]
	if !ok {
		return 0.5
	}
	total := rec.Successes + rec.Failures
	if total == 0 {
		return 0.5
	}
	return float64(rec.Successes) / float64(total)
}

// RecordOutcome increments the success or failure count for the bot and saves to disk.
func (t *CredibilityTracker) RecordOutcome(botSlug string, success bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec := t.data[botSlug]
	if success {
		rec.Successes++
	} else {
		rec.Failures++
	}
	t.data[botSlug] = rec
	_ = t.save()
}
