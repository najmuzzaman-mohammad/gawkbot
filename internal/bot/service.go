package bot

import (
	"fmt"
	"sort"
	"sync"
)

// ManagedBot wraps a BotLoop with its config and current state snapshot.
type ManagedBot struct {
	Config BotConfig
	State  BotState
	Loop   *BotLoop
}

// ConfigUpdate holds optional fields for updating a bot's configuration.
type ConfigUpdate struct {
	Name          *string
	Expertise     []string
	HeartbeatCron *string
}

// StreamFnResolver creates a StreamFn for a given bot slug.
// The service calls this when creating a BotLoop. It is the caller's
// responsibility to wire up the correct provider logic (e.g., based on config).
type StreamFnResolver func(botSlug string) StreamFn

// BotService is the singleton that manages all bot instances.
type BotService struct {
	bots             map[string]*ManagedBot
	toolRegistry     *ToolRegistry
	sessionStore     *SessionStore
	queues           *MessageQueues
	credTracker      *CredibilityTracker
	streamFnResolver StreamFnResolver
	escalator        Escalator
	listeners        []func()
	tickTimers       map[string]chan struct{} // per-bot worker stop channels
	mu               sync.Mutex
}

// BotServiceOption configures a BotService.
type BotServiceOption func(*BotService)

// WithToolRegistry sets the tool registry.
func WithToolRegistry(r *ToolRegistry) BotServiceOption {
	return func(s *BotService) { s.toolRegistry = r }
}

// WithSessionStore sets the session store.
func WithSessionStore(ss *SessionStore) BotServiceOption {
	return func(s *BotService) { s.sessionStore = ss }
}

// WithQueues sets the message queues.
func WithQueues(q *MessageQueues) BotServiceOption {
	return func(s *BotService) { s.queues = q }
}

// WithCredibilityTracker sets the credibility tracker.
func WithCredibilityTracker(ct *CredibilityTracker) BotServiceOption {
	return func(s *BotService) { s.credTracker = ct }
}

// WithStreamFnResolver sets the function that resolves a StreamFn per bot slug.
// This is the integration point for provider selection (claude-code, codex, gemini).
func WithStreamFnResolver(r StreamFnResolver) BotServiceOption {
	return func(s *BotService) { s.streamFnResolver = r }
}

// WithEscalator sets the escalation callback that newly-created bots inherit.
// Call this before Create(); for existing bots use AttachEscalator.
func WithEscalator(fn Escalator) BotServiceOption {
	return func(s *BotService) { s.escalator = fn }
}

// AttachEscalator overrides the escalator for every managed bot. Useful when
// the transport is wired after bots already exist.
func (s *BotService) AttachEscalator(fn Escalator) {
	s.mu.Lock()
	s.escalator = fn
	bots := make([]*ManagedBot, 0, len(s.bots))
	for _, ma := range s.bots {
		bots = append(bots, ma)
	}
	s.mu.Unlock()
	for _, ma := range bots {
		ma.Loop.SetEscalator(fn)
	}
}

// defaultStreamFnResolver returns a StreamFn that emits a configuration error.
// This is used when no real provider resolver is wired in — it tells the user
// to run /init so a provider gets configured.
func defaultStreamFnResolver() StreamFnResolver {
	return func(botSlug string) StreamFn {
		return func(msgs []Message, tools []BotTool) <-chan StreamChunk {
			ch := make(chan StreamChunk, 1)
			go func() {
				defer close(ch)
				ch <- StreamChunk{
					Type:    "text",
					Content: "No LLM provider configured. Run /init to set up.",
				}
			}()
			return ch
		}
	}
}

// NewBotService creates a BotService with sensible defaults.
// Defaults: creates a ToolRegistry with the local builtin tools, a session
// store, and message queues. Options override defaults.
func NewBotService(opts ...BotServiceOption) *BotService {
	s := &BotService{
		bots:       make(map[string]*ManagedBot),
		tickTimers: make(map[string]chan struct{}),
	}

	for _, opt := range opts {
		opt(s)
	}

	// Defaults.
	if s.toolRegistry == nil {
		s.toolRegistry = NewToolRegistry()
		for _, tool := range CreateBuiltinTools() {
			s.toolRegistry.Register(tool)
		}
	}
	if s.sessionStore == nil {
		ss, err := NewSessionStore()
		if err == nil {
			s.sessionStore = ss
		}
	}
	if s.queues == nil {
		s.queues = NewMessageQueues()
	}
	if s.streamFnResolver == nil {
		s.streamFnResolver = defaultStreamFnResolver()
	}

	return s
}

// Create creates a new managed bot from the given config.
// Returns an error if the slug already exists.
func (s *BotService) Create(cfg BotConfig) (*ManagedBot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.bots[cfg.Slug]; exists {
		return nil, fmt.Errorf("bot %q already exists", cfg.Slug)
	}

	cfg = botConfigSnapshot(cfg)
	streamFn := s.streamFnResolver(cfg.Slug)

	loop := NewBotLoop(cfg, s.toolRegistry, s.sessionStore, s.queues, streamFn, s.credTracker)

	ma := &ManagedBot{
		Config: cfg,
		State:  loop.GetState(),
		Loop:   loop,
	}

	if s.escalator != nil {
		ma.Loop.SetEscalator(s.escalator)
	}

	s.bots[cfg.Slug] = ma
	s.notify()
	return ma, nil
}

// CreateFromTemplate looks up a legacy compatibility template by name, merges
// the slug, and calls Create.
func (s *BotService) CreateFromTemplate(slug, templateName string) (*ManagedBot, error) {
	tmpl, ok := LookupLegacyTemplate(templateName)
	if !ok {
		return nil, fmt.Errorf("unknown template: %q", templateName)
	}
	cfg := tmpl
	cfg.Slug = slug
	return s.Create(cfg)
}

// Start starts the bot loop.
func (s *BotService) Start(slug string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	ma, err := s.requireBot(slug)
	if err != nil {
		return err
	}

	ma.Loop.Start()
	s.notify()
	return nil
}

// Stop stops the bot loop and its tick timer.
func (s *BotService) Stop(slug string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	ma, err := s.requireBot(slug)
	if err != nil {
		return err
	}

	// Stop the tick timer goroutine if running.
	if stopCh, ok := s.tickTimers[slug]; ok {
		close(stopCh)
		delete(s.tickTimers, slug)
	}

	ma.Loop.Stop()
	s.notify()
	return nil
}

// Steer pushes a steering message to the bot's queue.
func (s *BotService) Steer(slug, message string) error {
	s.mu.Lock()
	ma, err := s.requireBot(slug)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	s.queues.Steer(slug, message)
	s.mu.Unlock()
	if ma.Loop.IsBusy() {
		ma.Loop.Interrupt()
	}
	s.EnsureRunning(slug)
	return nil
}

// FollowUp pushes a follow-up message to the bot's queue.
func (s *BotService) FollowUp(slug, message string) error {
	s.mu.Lock()
	ma, err := s.requireBot(slug)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	s.queues.FollowUp(slug, message)
	s.mu.Unlock()
	if ma.Loop.IsBusy() {
		ma.Loop.Interrupt()
	}
	s.EnsureRunning(slug)
	return nil
}

// HumanMessage pushes a high-priority message from a real person into the
// bot's queue. It always interrupts any in-flight LLM or tool work so the
// bot absorbs the human's message before resuming any prior bot-originated
// task. Use this for chat (channel or DM) messages, whether the bot was
// tagged or not — the human takes priority over bot-to-bot follow-ups.
func (s *BotService) HumanMessage(slug, message string) error {
	s.mu.Lock()
	ma, err := s.requireBot(slug)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	s.queues.Human(slug, message)
	s.mu.Unlock()
	if ma.Loop.IsBusy() {
		ma.Loop.Interrupt()
	}
	s.EnsureRunning(slug)
	return nil
}

// EnsureRunning starts an idempotent worker that drives the bot loop immediately.
// The worker exits as soon as the bot is idle and has no queued messages.
func (s *BotService) EnsureRunning(slug string) {
	s.mu.Lock()
	if _, ok := s.tickTimers[slug]; ok {
		s.mu.Unlock()
		return
	}

	ma, err := s.requireBot(slug)
	if err != nil {
		s.mu.Unlock()
		return
	}
	if !ma.Loop.CanProcess() {
		s.mu.Unlock()
		return
	}

	stopCh := make(chan struct{})
	s.tickTimers[slug] = stopCh
	s.mu.Unlock()

	go s.runBotWorker(slug, ma, stopCh)
}

func (s *BotService) runBotWorker(slug string, ma *ManagedBot, stopCh <-chan struct{}) {
	for {
		select {
		case <-stopCh:
			return
		default:
		}

		s.mu.Lock()
		current, ok := s.bots[slug]
		if !ok || current != ma {
			delete(s.tickTimers, slug)
			s.mu.Unlock()
			return
		}
		state := ma.Loop.GetState()
		hasMessages := s.queues.HasMessages(slug)
		shouldStop := !hasMessages && (state.Phase == PhaseIdle || state.Phase == PhaseDone || state.Phase == PhaseError)
		s.mu.Unlock()

		if shouldStop {
			s.mu.Lock()
			if cur, stillRegistered := s.bots[slug]; stillRegistered && cur == ma {
				delete(s.tickTimers, slug)
			}
			s.mu.Unlock()
			return
		}

		_ = ma.Loop.Tick()
		ma.Loop.NotifyTick()
		nextState := ma.Loop.GetState()

		s.mu.Lock()
		current, ok = s.bots[slug]
		if !ok || current != ma {
			delete(s.tickTimers, slug)
			s.mu.Unlock()
			return
		}
		running := ma.Loop.CanProcess() &&
			((nextState.Phase != PhaseDone && nextState.Phase != PhaseIdle) || s.queues.HasMessages(slug))
		s.mu.Unlock()

		if !running {
			s.mu.Lock()
			if cur, stillRegistered := s.bots[slug]; stillRegistered && cur == ma {
				delete(s.tickTimers, slug)
			}
			s.mu.Unlock()
			return
		}
	}
}

// Get returns the managed bot for the given slug.
func (s *BotService) Get(slug string) (*ManagedBot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ma, ok := s.bots[slug]
	if !ok {
		return nil, false
	}
	snapshot := *ma
	snapshot.Config = botConfigSnapshot(ma.Config)
	snapshot.State = botStateSnapshot(ma.Loop.GetState())
	return &snapshot, true
}

// List returns all managed bots, sorted by slug.
func (s *BotService) List() []*ManagedBot {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := make([]*ManagedBot, 0, len(s.bots))
	for _, ma := range s.bots {
		snapshot := *ma
		snapshot.Config = botConfigSnapshot(ma.Config)
		snapshot.State = botStateSnapshot(ma.Loop.GetState())
		list = append(list, &snapshot)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].Config.Slug < list[j].Config.Slug
	})
	return list
}

// GetState returns the current state for the given bot slug.
func (s *BotService) GetState(slug string) (BotState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ma, ok := s.bots[slug]
	if !ok {
		return BotState{}, false
	}
	return botStateSnapshot(ma.Loop.GetState()), true
}

func botConfigSnapshot(cfg BotConfig) BotConfig {
	cfg.Expertise = append([]string(nil), cfg.Expertise...)
	cfg.Tools = append([]string(nil), cfg.Tools...)
	cfg.AllowedTools = append([]string(nil), cfg.AllowedTools...)
	if cfg.Budget != nil {
		budget := *cfg.Budget
		cfg.Budget = &budget
	}
	return cfg
}

func botStateSnapshot(state BotState) BotState {
	state.Config = botConfigSnapshot(state.Config)
	return state
}

// Remove stops and removes the bot from the service.
func (s *BotService) Remove(slug string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.bots[slug]; !ok {
		return fmt.Errorf("bot %q not found", slug)
	}

	// Stop tick timer if running.
	if stopCh, ok := s.tickTimers[slug]; ok {
		close(stopCh)
		delete(s.tickTimers, slug)
	}

	s.bots[slug].Loop.Stop()
	delete(s.bots, slug)
	s.notify()
	return nil
}

// Subscribe registers a listener that is called whenever bot state changes.
// Returns an unsubscribe function.
func (s *BotService) Subscribe(listener func()) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listeners = append(s.listeners, listener)

	idx := len(s.listeners) - 1
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if idx < len(s.listeners) {
			s.listeners = append(s.listeners[:idx], s.listeners[idx+1:]...)
		}
	}
}

// GetTemplateNames returns the names of all legacy compatibility templates,
// sorted.
func (s *BotService) GetTemplateNames() []string {
	names := LegacyTemplateNames()
	sort.Strings(names)
	return names
}

// GetTemplate returns the config for a named legacy compatibility template.
func (s *BotService) GetTemplate(name string) (BotConfig, bool) {
	return LookupLegacyTemplate(name)
}

// UpdateConfig updates mutable fields on a running bot's config.
func (s *BotService) UpdateConfig(slug string, updates ConfigUpdate) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	ma, err := s.requireBot(slug)
	if err != nil {
		return err
	}

	if updates.Name != nil {
		ma.Config.Name = *updates.Name
	}
	if updates.Expertise != nil {
		ma.Config.Expertise = updates.Expertise
	}
	if updates.HeartbeatCron != nil {
		ma.Config.HeartbeatCron = *updates.HeartbeatCron
	}

	s.notify()
	return nil
}

// notify calls all listeners, swallowing panics. Must be called with mu held.
func (s *BotService) notify() {
	for _, fn := range s.listeners {
		func() {
			defer func() { _ = recover() }()
			fn()
		}()
	}
}

// requireBot returns the managed bot for slug or an error if not found.
// Must be called with mu held.
func (s *BotService) requireBot(slug string) (*ManagedBot, error) {
	ma, ok := s.bots[slug]
	if !ok {
		return nil, fmt.Errorf("bot %q not found", slug)
	}
	return ma, nil
}
