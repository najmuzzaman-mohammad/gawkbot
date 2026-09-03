package bot

import (
	"sync"
	"testing"
	"time"
)

func newTestService(t *testing.T, streamFn StreamFn) *BotService {
	t.Helper()
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	tools := NewToolRegistry()
	queues := NewMessageQueues()

	return NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)
}

func TestCreateFromTemplate(t *testing.T) {
	svc := newTestService(t, nil)

	ma, err := svc.CreateFromTemplate("my-seo", "seo-agent")
	if err != nil {
		t.Fatalf("CreateFromTemplate: %v", err)
	}

	if ma.Config.Slug != "my-seo" {
		t.Errorf("expected slug 'my-seo', got %q", ma.Config.Slug)
	}
	if ma.Config.Name != "SEO Analyst" {
		t.Errorf("expected name 'SEO Analyst', got %q", ma.Config.Name)
	}

	// Verify it exists in the service.
	got, ok := svc.Get("my-seo")
	if !ok {
		t.Fatal("expected bot to exist after Create")
	}
	if got.Config.Slug != "my-seo" {
		t.Errorf("Get returned wrong slug: %q", got.Config.Slug)
	}
}

func TestCreateDuplicateSlug(t *testing.T) {
	svc := newTestService(t, nil)

	_, err := svc.Create(BotConfig{Slug: "dup", Name: "Dup"})
	if err != nil {
		t.Fatalf("first Create: %v", err)
	}

	_, err = svc.Create(BotConfig{Slug: "dup", Name: "Dup2"})
	if err == nil {
		t.Fatal("expected error for duplicate slug")
	}
}

func TestCreateFromUnknownTemplate(t *testing.T) {
	svc := newTestService(t, nil)

	_, err := svc.CreateFromTemplate("x", "nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown template")
	}
}

func TestStartStopLifecycle(t *testing.T) {
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	queues := NewMessageQueues()
	tools := NewToolRegistry()

	svc := NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)

	cfg := BotConfig{
		Slug:      "lifecycle",
		Name:      "Lifecycle Bot",
		Expertise: []string{"testing"},
	}

	_, err := svc.Create(cfg)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Start.
	if err := svc.Start("lifecycle"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	state, ok := svc.GetState("lifecycle")
	if !ok {
		t.Fatal("expected bot state")
	}
	if state.Phase != PhaseIdle {
		t.Errorf("expected idle after Start, got %s", state.Phase)
	}

	// Stop.
	if err := svc.Stop("lifecycle"); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	// Start/stop on nonexistent slug.
	if err := svc.Start("nope"); err == nil {
		t.Error("expected error starting nonexistent bot")
	}
	if err := svc.Stop("nope"); err == nil {
		t.Error("expected error stopping nonexistent bot")
	}
}

func TestSteerMessageDelivery(t *testing.T) {
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	queues := NewMessageQueues()
	tools := NewToolRegistry()

	svc := NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)

	cfg := BotConfig{
		Slug: "steer-test",
		Name: "Steer Test",
	}
	svc.Create(cfg)

	if err := svc.Steer("steer-test", "go left"); err != nil {
		t.Fatalf("Steer: %v", err)
	}

	// Verify the queue has the message.
	if !queues.HasSteer("steer-test") {
		t.Error("expected steer message in queue")
	}

	msg, ok := queues.DrainSteer("steer-test")
	if !ok || msg != "go left" {
		t.Errorf("expected 'go left', got %q (ok=%v)", msg, ok)
	}

	// Steer on nonexistent.
	if err := svc.Steer("nope", "x"); err == nil {
		t.Error("expected error steering nonexistent bot")
	}
}

func TestFollowUpMessageDelivery(t *testing.T) {
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	queues := NewMessageQueues()
	tools := NewToolRegistry()

	svc := NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)

	cfg := BotConfig{
		Slug: "followup-test",
		Name: "FollowUp Test",
	}
	svc.Create(cfg)

	if err := svc.FollowUp("followup-test", "continue"); err != nil {
		t.Fatalf("FollowUp: %v", err)
	}

	if !queues.HasFollowUp("followup-test") {
		t.Error("expected follow-up message in queue")
	}

	// FollowUp on nonexistent.
	if err := svc.FollowUp("nope", "x"); err == nil {
		t.Error("expected error for nonexistent bot")
	}
}

func TestHumanMessageDelivery(t *testing.T) {
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	queues := NewMessageQueues()
	tools := NewToolRegistry()

	svc := NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)

	cfg := BotConfig{
		Slug: "human-test",
		Name: "Human Test",
	}
	svc.Create(cfg)

	if err := svc.HumanMessage("human-test", "are you stuck?"); err != nil {
		t.Fatalf("HumanMessage: %v", err)
	}

	if !queues.HasHuman("human-test") {
		t.Error("expected human message in human-priority queue")
	}
	if queues.HasFollowUp("human-test") {
		t.Error("human message must not leak into follow-up queue")
	}

	msg, ok := queues.DrainHuman("human-test")
	if !ok || msg != "are you stuck?" {
		t.Errorf("DrainHuman = (%q, %v), want (\"are you stuck?\", true)", msg, ok)
	}

	if err := svc.HumanMessage("nope", "x"); err == nil {
		t.Error("expected error for nonexistent bot")
	}
}

func TestSubscribeUnsubscribe(t *testing.T) {
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	queues := NewMessageQueues()
	tools := NewToolRegistry()

	svc := NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)

	var mu sync.Mutex
	callCount := 0
	unsub := svc.Subscribe(func() {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	// Create a bot — should fire the listener.
	svc.Create(BotConfig{Slug: "sub-test", Name: "Sub Test"})

	mu.Lock()
	c := callCount
	mu.Unlock()
	if c == 0 {
		t.Error("expected listener to fire on Create")
	}

	// Unsubscribe.
	unsub()

	beforeCount := c
	svc.Create(BotConfig{Slug: "sub-test-2", Name: "Sub Test 2"})

	mu.Lock()
	c = callCount
	mu.Unlock()
	if c != beforeCount {
		t.Errorf("expected no more calls after unsubscribe, got %d (was %d)", c, beforeCount)
	}
}

func TestEnsureRunningTickLoop(t *testing.T) {
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	queues := NewMessageQueues()
	tools := NewToolRegistry()

	// Use a channel-based mock StreamFn that signals when it's called.
	streamCalled := make(chan struct{}, 10)
	mockStream := func(msgs []Message, tls []BotTool) <-chan StreamChunk {
		ch := make(chan StreamChunk, 1)
		go func() {
			defer close(ch)
			select {
			case streamCalled <- struct{}{}:
			default:
			}
			ch <- StreamChunk{Type: "text", Content: "tick response"}
		}()
		return ch
	}

	svc := NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)

	// Create and manually wire the stream function into the loop.
	cfg := BotConfig{
		Slug:      "tick-test",
		Name:      "Tick Test",
		Expertise: []string{"testing"},
	}
	ma, err := svc.Create(cfg)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Replace the loop's stream function with our mock.
	// Since we're in the same package, we can access internal fields.
	ma.Loop.streamFn = mockStream

	// Enqueue a message and start the loop.
	queues.FollowUp("tick-test", "do something")
	svc.Start("tick-test")
	svc.EnsureRunning("tick-test")

	// Wait for the stream to be called (the tick loop should trigger it).
	select {
	case <-streamCalled:
		// Success — the worker loop is running and progressing the bot.
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for tick loop to call streamFn")
	}

	// Stop should clean up.
	if err := svc.Stop("tick-test"); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	// Calling EnsureRunning again after stop should be safe (no-op since bot is stopped).
	svc.EnsureRunning("tick-test")
}

func TestFollowUpStartsRunningBotImmediately(t *testing.T) {
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	queues := NewMessageQueues()
	tools := NewToolRegistry()

	streamCalled := make(chan struct{}, 1)
	mockStream := func(msgs []Message, tls []BotTool) <-chan StreamChunk {
		ch := make(chan StreamChunk, 1)
		go func() {
			defer close(ch)
			select {
			case streamCalled <- struct{}{}:
			default:
			}
			ch <- StreamChunk{Type: "text", Content: "queued response"}
		}()
		return ch
	}

	svc := NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)

	ma, err := svc.Create(BotConfig{Slug: "auto-start", Name: "Auto Start"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	ma.Loop.streamFn = mockStream
	if err := svc.Start("auto-start"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if err := svc.FollowUp("auto-start", "respond now"); err != nil {
		t.Fatalf("FollowUp: %v", err)
	}

	select {
	case <-streamCalled:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for follow-up to start bot work")
	}

	// Drain the worker before t.TempDir cleanup — otherwise the tick goroutine
	// can still be writing under `dir/auto-start/` when RemoveAll runs, which
	// surfaces on slow runners (observed under `-race` on ubuntu-latest) as
	// `TempDir RemoveAll cleanup: directory not empty`.
	if err := svc.Stop("auto-start"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		svc.mu.Lock()
		_, running := svc.tickTimers["auto-start"]
		svc.mu.Unlock()
		if !running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("tick worker still running after Stop")
}

func TestEnsureRunningDoesNotHoldServiceMutexDuringTick(t *testing.T) {
	dir := t.TempDir()
	sessions := NewSessionStoreAt(dir)
	queues := NewMessageQueues()
	tools := NewToolRegistry()

	started := make(chan struct{}, 1)
	release := make(chan struct{})
	streamFinished := make(chan struct{}, 1)
	mockStream := func(msgs []Message, tls []BotTool) <-chan StreamChunk {
		ch := make(chan StreamChunk)
		go func() {
			defer func() {
				select {
				case streamFinished <- struct{}{}:
				default:
				}
			}()
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			ch <- StreamChunk{Type: "text", Content: "done"}
			close(ch)
		}()
		return ch
	}

	svc := NewBotService(
		WithToolRegistry(tools),
		WithSessionStore(sessions),
		WithQueues(queues),
	)

	ma, err := svc.Create(BotConfig{Slug: "blocking", Name: "Blocking Bot"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	ma.Loop.streamFn = mockStream

	queues.FollowUp("blocking", "do something")
	if err := svc.Start("blocking"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	svc.EnsureRunning("blocking")

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for blocking tick to start")
	}

	done := make(chan struct{})
	go func() {
		_ = svc.List()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("List blocked while bot tick was in progress")
	}

	done = make(chan struct{})
	go func() {
		_, _ = svc.GetState("blocking")
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("GetState blocked while bot tick was in progress")
	}

	close(release)

	select {
	case <-streamFinished:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for blocked stream to finish")
	}

	if err := svc.Stop("blocking"); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		svc.mu.Lock()
		_, running := svc.tickTimers["blocking"]
		svc.mu.Unlock()
		if !running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("tick timer still running after Stop")
}

func TestListBots(t *testing.T) {
	svc := newTestService(t, nil)

	svc.Create(BotConfig{Slug: "b-agent", Name: "B"})
	svc.Create(BotConfig{Slug: "a-agent", Name: "A"})

	list := svc.List()
	if len(list) != 2 {
		t.Fatalf("expected 2 bots, got %d", len(list))
	}
	if list[0].Config.Slug != "a-agent" {
		t.Errorf("expected first bot 'a-bot', got %q", list[0].Config.Slug)
	}
	if list[1].Config.Slug != "b-agent" {
		t.Errorf("expected second bot 'b-bot', got %q", list[1].Config.Slug)
	}
}

func TestBotSnapshotsDoNotAliasConfig(t *testing.T) {
	svc := newTestService(t, nil)

	_, err := svc.Create(BotConfig{
		Slug:         "snapshot-agent",
		Name:         "Snapshot Bot",
		Expertise:    []string{"backend"},
		Tools:        []string{"search"},
		AllowedTools: []string{"read_file"},
		Budget:       &BudgetLimit{MaxTokens: 1000, MaxCostUsd: 1.5},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, ok := svc.Get("snapshot-agent")
	if !ok {
		t.Fatal("expected bot from Get")
	}
	got.Config.Expertise[0] = "mutated"
	got.Config.Tools[0] = "mutated"
	got.Config.AllowedTools[0] = "mutated"
	got.Config.Budget.MaxTokens = 1
	got.State.Config.Expertise[0] = "mutated"
	got.State.Config.Tools[0] = "mutated"
	got.State.Config.AllowedTools[0] = "mutated"
	got.State.Config.Budget.MaxTokens = 2

	list := svc.List()
	if len(list) != 1 {
		t.Fatalf("expected 1 bot, got %d", len(list))
	}
	assertSnapshotConfigUnchanged(t, list[0].Config)
	assertSnapshotConfigUnchanged(t, list[0].State.Config)

	list[0].Config.Expertise[0] = "mutated-again"
	list[0].Config.Tools[0] = "mutated-again"
	list[0].Config.AllowedTools[0] = "mutated-again"
	list[0].Config.Budget.MaxTokens = 3
	list[0].State.Config.Expertise[0] = "mutated-again"
	list[0].State.Config.Tools[0] = "mutated-again"
	list[0].State.Config.AllowedTools[0] = "mutated-again"
	list[0].State.Config.Budget.MaxTokens = 4

	state, ok := svc.GetState("snapshot-agent")
	if !ok {
		t.Fatal("expected bot state")
	}
	assertSnapshotConfigUnchanged(t, state.Config)
	state.Config.Expertise[0] = "mutated-state"
	state.Config.Tools[0] = "mutated-state"
	state.Config.AllowedTools[0] = "mutated-state"
	state.Config.Budget.MaxTokens = 5

	got, ok = svc.Get("snapshot-agent")
	if !ok {
		t.Fatal("expected bot from Get")
	}
	assertSnapshotConfigUnchanged(t, got.Config)
	assertSnapshotConfigUnchanged(t, got.State.Config)
}

// TestCreateSnapshotsInboundConfig verifies Create() copies the caller's
// BotConfig — mutating the caller's slices/Budget after Create must not
// affect what subsequent List/Get returns. This catches regressions where
// Create stops calling botConfigSnapshot on the way in.
func TestCreateSnapshotsInboundConfig(t *testing.T) {
	svc := newTestService(t, nil)
	cfg := BotConfig{
		Slug:         "create-snapshot",
		Name:         "Create Snapshot",
		Expertise:    []string{"research"},
		Tools:        []string{"lookup"},
		Budget:       &BudgetLimit{MaxTokens: 100},
		AllowedTools: []string{"read"},
	}
	if _, err := svc.Create(cfg); err != nil {
		t.Fatalf("Create: %v", err)
	}

	cfg.Expertise[0] = "mutated"
	cfg.Tools[0] = "mutated"
	cfg.Budget.MaxTokens = 1
	cfg.AllowedTools[0] = "mutated"

	got := svc.List()[0].Config
	if got.Expertise[0] != "research" {
		t.Fatalf("Expertise alias leaked through Create: %#v", got.Expertise)
	}
	if got.Tools[0] != "lookup" {
		t.Fatalf("Tools alias leaked through Create: %#v", got.Tools)
	}
	if got.Budget.MaxTokens != 100 {
		t.Fatalf("Budget alias leaked through Create: %#v", got.Budget)
	}
	if got.AllowedTools[0] != "read" {
		t.Fatalf("AllowedTools alias leaked through Create: %#v", got.AllowedTools)
	}
}

func assertSnapshotConfigUnchanged(t *testing.T, cfg BotConfig) {
	t.Helper()

	if len(cfg.Expertise) != 1 || cfg.Expertise[0] != "backend" {
		t.Errorf("expected expertise to remain [backend], got %v", cfg.Expertise)
	}
	if len(cfg.Tools) != 1 || cfg.Tools[0] != "search" {
		t.Errorf("expected tools to remain [search], got %v", cfg.Tools)
	}
	if len(cfg.AllowedTools) != 1 || cfg.AllowedTools[0] != "read_file" {
		t.Errorf("expected allowed tools to remain [read_file], got %v", cfg.AllowedTools)
	}
	if cfg.Budget == nil {
		t.Fatal("expected budget")
	}
	if cfg.Budget.MaxTokens != 1000 {
		t.Errorf("expected budget max tokens to remain 1000, got %d", cfg.Budget.MaxTokens)
	}
}

func TestRemoveBot(t *testing.T) {
	svc := newTestService(t, nil)

	svc.Create(BotConfig{Slug: "remove-me", Name: "Remove Me"})
	if err := svc.Remove("remove-me"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	_, ok := svc.Get("remove-me")
	if ok {
		t.Error("expected bot to be removed")
	}

	if err := svc.Remove("remove-me"); err == nil {
		t.Error("expected error removing nonexistent bot")
	}
}

func TestGetTemplateNames(t *testing.T) {
	svc := newTestService(t, nil)
	names := svc.GetTemplateNames()
	if len(names) == 0 {
		t.Fatal("expected template names")
	}

	// Verify sorted.
	for i := 1; i < len(names); i++ {
		if names[i] < names[i-1] {
			t.Errorf("template names not sorted: %v", names)
			break
		}
	}
}

func TestGetTemplate(t *testing.T) {
	svc := newTestService(t, nil)

	cfg, ok := svc.GetTemplate("seo-agent")
	if !ok {
		t.Fatal("expected seo-bot template to exist")
	}
	if cfg.Name != "SEO Analyst" {
		t.Errorf("expected 'SEO Analyst', got %q", cfg.Name)
	}

	_, ok = svc.GetTemplate("nonexistent")
	if ok {
		t.Error("expected nonexistent template to not exist")
	}
}

func TestUpdateConfig(t *testing.T) {
	svc := newTestService(t, nil)

	svc.Create(BotConfig{Slug: "update-me", Name: "Original", Expertise: []string{"a"}})

	newName := "Updated"
	newCron := "0 */2 * * *"
	err := svc.UpdateConfig("update-me", ConfigUpdate{
		Name:          &newName,
		Expertise:     []string{"b", "c"},
		HeartbeatCron: &newCron,
	})
	if err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	ma, ok := svc.Get("update-me")
	if !ok {
		t.Fatal("expected bot to exist")
	}
	if ma.Config.Name != "Updated" {
		t.Errorf("expected name 'Updated', got %q", ma.Config.Name)
	}
	if len(ma.Config.Expertise) != 2 || ma.Config.Expertise[0] != "b" {
		t.Errorf("expected expertise [b, c], got %v", ma.Config.Expertise)
	}
	if ma.Config.HeartbeatCron != "0 */2 * * *" {
		t.Errorf("expected cron '0 */2 * * *', got %q", ma.Config.HeartbeatCron)
	}

	// Update nonexistent.
	if err := svc.UpdateConfig("nope", ConfigUpdate{}); err == nil {
		t.Error("expected error for nonexistent bot")
	}
}
