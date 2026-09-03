package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type claudeSessionRecord struct {
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd,omitempty"`
	UpdatedAt int64  `json:"updated_at,omitempty"`
}

type claudeSessionStore struct {
	mu       sync.Mutex
	path     string
	sessions map[string]claudeSessionRecord
}

var (
	claudeSessionStoreMu       sync.Mutex
	claudeSessionStoreInstance *claudeSessionStore
	claudeSessionStoreFactory  = func() *claudeSessionStore {
		return newClaudeSessionStore()
	}
)

func getClaudeSessionStore() *claudeSessionStore {
	claudeSessionStoreMu.Lock()
	defer claudeSessionStoreMu.Unlock()

	if claudeSessionStoreInstance == nil {
		claudeSessionStoreInstance = claudeSessionStoreFactory()
	}
	return claudeSessionStoreInstance
}

// ResetClaudeSessions clears all persisted Claude resume state.
func ResetClaudeSessions() error {
	claudeSessionStoreMu.Lock()
	store := claudeSessionStoreInstance
	if store == nil {
		store = claudeSessionStoreFactory()
		claudeSessionStoreInstance = store
	}
	claudeSessionStoreMu.Unlock()

	return store.clearAll()
}

// ResetClaudeSessionFor clears the persisted Claude resume entry for a
// single bot slug. Used after a per-bot provider switch so a slug that
// just moved away from claude-code doesn't carry a stale Claude session id
// into the new runtime — the next dispatch starts clean.
//
// Idempotent: clearing a slug with no recorded session is a no-op.
func ResetClaudeSessionFor(botSlug string) {
	if strings.TrimSpace(botSlug) == "" {
		return
	}
	claudeSessionStoreMu.Lock()
	store := claudeSessionStoreInstance
	if store == nil {
		store = claudeSessionStoreFactory()
		claudeSessionStoreInstance = store
	}
	claudeSessionStoreMu.Unlock()

	store.clear(botSlug)
}

func newClaudeSessionStore() *claudeSessionStore {
	home, err := os.UserHomeDir()
	if err != nil {
		return newClaudeSessionStoreAt("")
	}
	return newClaudeSessionStoreAt(filepath.Join(home, ".wuphf", "providers", "claude-sessions.json"))
}

func newClaudeSessionStoreAt(path string) *claudeSessionStore {
	store := &claudeSessionStore{
		path:     path,
		sessions: make(map[string]claudeSessionRecord),
	}
	store.load()
	return store
}

func (s *claudeSessionStore) resumeSessionID(botSlug string, cwd string) string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	record, ok := s.sessions[botSlug]
	if !ok || record.SessionID == "" {
		return ""
	}
	if record.Cwd != "" && cwd != "" && record.Cwd != cwd {
		return ""
	}
	return record.SessionID
}

func (s *claudeSessionStore) save(botSlug string, sessionID string, cwd string) {
	if s == nil || botSlug == "" || sessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sessions[botSlug] = claudeSessionRecord{
		SessionID: sessionID,
		Cwd:       cwd,
		UpdatedAt: time.Now().UnixMilli(),
	}
	s.persist()
}

func (s *claudeSessionStore) clear(botSlug string) {
	if s == nil || botSlug == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.sessions, botSlug)
	s.persist()
}

func (s *claudeSessionStore) clearAll() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sessions = make(map[string]claudeSessionRecord)
	if s.path == "" {
		return nil
	}
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *claudeSessionStore) load() {
	if s == nil || s.path == "" {
		return
	}

	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}

	loaded := make(map[string]claudeSessionRecord)
	if err := json.Unmarshal(data, &loaded); err != nil {
		return
	}
	s.sessions = loaded
}

func (s *claudeSessionStore) persist() {
	if s == nil || s.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return
	}
	data, err := json.MarshalIndent(s.sessions, "", "  ")
	if err != nil {
		return
	}
	data = append(data, '\n')
	_ = os.WriteFile(s.path, data, 0o600)
}
