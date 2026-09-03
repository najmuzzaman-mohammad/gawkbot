package team

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stubTaskWorktreePath returns the canonical stub path + branch shape used
// by both the in-package worktree guard (worktree_guard_test.go) and the
// cross-package helper below. Shape mirrors production
// (<root>/.wuphf/task-worktrees/<repoToken>/wuphf-task-<id>) so test
// assertions on the worktree path format stay consistent with real
// behavior. Having two different stub shapes in the past let tests drift
// apart — one stub passing "contains .wuphf/task-worktrees/" while the
// other didn't — so this is the single source of truth.
func stubTaskWorktreePath(taskID string) (string, string) {
	id := sanitizeWorktreeToken(taskID)
	root := defaultTaskWorktreeRootDir("stub")
	return filepath.Join(root, "wuphf-task-"+id), "wuphf-" + id
}

// DisableRealTaskWorktreeForTests replaces the package-level
// prepare/cleanup task worktree funcs with no-op stubs and flips the
// broker-state-load + real-worktree guards so that tests which exercise
// the local_worktree dispatch path (handleTeamTask etc.) cannot reach
// `git worktree add` against the developer's wuphf repo, nor load stale
// state from the user's real ~/.wuphf/.
//
// Intended for TestMain in packages that depend on team and exercise
// this codepath via integration tests. Currently only
// internal/teammcp/testmain_test.go. Grep for `ExecutionMode:
// "local_worktree"` in internal/*/\*_test.go to find additional
// candidates.
//
// Guarded by testing.Testing() so a production caller panics
// immediately instead of silently corrupting the real task dispatcher
// for the lifetime of the process. The in-package tests inside the team
// package get equivalent guards from worktree_guard_test.go's init.
func DisableRealTaskWorktreeForTests() {
	if !testing.Testing() {
		panic("team: DisableRealTaskWorktreeForTests must only be called from tests " +
			"(it mutates package-level worktree dispatch vars with no restore path)")
	}
	allowRealTaskWorktree.Store(false)
	computerRuntimeAllowed.Store(false)
	skipBrokerStateLoadOnConstruct = true
	prep := prepareTaskWorktreeFn(func(taskID string) (string, string, error) {
		path, branch := stubTaskWorktreePath(taskID)
		return path, branch, nil
	})
	prepareTaskWorktreeOverride.Store(&prep)
	cleanup := cleanupTaskWorktreeFn(func(string, string) error { return nil })
	cleanupTaskWorktreeOverride.Store(&cleanup)
	// Stub verifyTaskWorktreeWritable too: rejectFalseLocalWorktreeBlock
	// in broker.go calls it with the stub path, which never exists on
	// disk, so the default `os.Stat` check would fail. No tests exercise
	// this path today, but keeping the three worktree vars stubbed
	// together preserves the "real-worktree is off for tests" contract
	// as defense-in-depth for future callers.
	verify := verifyTaskWorktreeWritableFn(func(string) error { return nil })
	verifyTaskWorktreeWritableOverride.Store(&verify)

	// If the caller's test package hasn't set WUPHF_RUNTIME_HOME, point
	// it at a process-lifetime leaked tempdir so any implicit
	// ~/.wuphf/... write falls through to /tmp instead of the user's
	// real home. Matches worktree_guard_test.go's init for the team
	// package's own tests. Tests that override with t.Setenv take
	// precedence and their restore lands on this safe default.
	if os.Getenv("WUPHF_RUNTIME_HOME") == "" {
		if dir, err := os.MkdirTemp("", "wuphf-disable-real-worktree-home-*"); err == nil {
			_ = os.Setenv("WUPHF_RUNTIME_HOME", dir)
		}
	}
}

// setHeadlessCodexRunTurnForTest redirects headlessCodexRunTurn(...) to fn
// for the duration of the test, then restores the prior override on cleanup.
//
// Tests previously did `oldFn := headlessCodexRunTurn; headlessCodexRunTurn = ...`
// against a package-level var. That pattern was a data race against the
// queue worker spawned by enqueueHeadlessCodexTurnRecord — the worker could
// outlive the test's deferred restore and observe the swap mid-call. Use
// this helper instead.
//
// CONSTRAINT: tests using any setXForTest helper in this file must NOT call
// t.Parallel(). The setters do an atomic Load → atomic Store pair which is
// non-atomic AS A PAIR; parallel setters can scramble the cleanup chain (T1
// captures prior=A, T2 captures prior=A, T1 stores B, T2 stores C, T1
// cleanup stores A, T2 cleanup stores A — both lose). Single-test
// race-safety against background goroutines is the goal here, not parallel
// test composition.
func setHeadlessCodexRunTurnForTest(t *testing.T, fn func(l *Launcher, ctx context.Context, slug, notification string, channel ...string) error) {
	t.Helper()
	prior := headlessCodexRunTurnOverride.Load()
	headlessCodexRunTurnOverride.Store(&fn)
	t.Cleanup(func() {
		headlessCodexRunTurnOverride.Store(prior)
	})
}

// setPrepareTaskWorktreeForTest swaps the prepareTaskWorktree dispatcher
// for the duration of the test. Same race motivation as
// setHeadlessCodexRunTurnForTest: the headless queue worker can read the
// dispatcher after the test's deferred restore has already run.
func setPrepareTaskWorktreeForTest(t *testing.T, fn prepareTaskWorktreeFn) {
	t.Helper()
	prior := prepareTaskWorktreeOverride.Load()
	prepareTaskWorktreeOverride.Store(&fn)
	t.Cleanup(func() {
		prepareTaskWorktreeOverride.Store(prior)
	})
}

// setCleanupTaskWorktreeForTest swaps the cleanupTaskWorktree dispatcher
// for the duration of the test.
func setCleanupTaskWorktreeForTest(t *testing.T, fn cleanupTaskWorktreeFn) {
	t.Helper()
	prior := cleanupTaskWorktreeOverride.Load()
	cleanupTaskWorktreeOverride.Store(&fn)
	t.Cleanup(func() {
		cleanupTaskWorktreeOverride.Store(prior)
	})
}

// setTaskWorktreeRootDirForTest swaps the taskWorktreeRootDir dispatcher
// for the duration of the test.
func setTaskWorktreeRootDirForTest(t *testing.T, fn taskWorktreeRootDirFn) {
	t.Helper()
	prior := taskWorktreeRootDirOverride.Load()
	taskWorktreeRootDirOverride.Store(&fn)
	t.Cleanup(func() {
		taskWorktreeRootDirOverride.Store(prior)
	})
}

// setVerifyTaskWorktreeWritableForTest swaps the verifyTaskWorktreeWritable
// dispatcher for the duration of the test.
func setVerifyTaskWorktreeWritableForTest(t *testing.T, fn verifyTaskWorktreeWritableFn) {
	t.Helper()
	prior := verifyTaskWorktreeWritableOverride.Load()
	verifyTaskWorktreeWritableOverride.Store(&fn)
	t.Cleanup(func() {
		verifyTaskWorktreeWritableOverride.Store(prior)
	})
}

// setHeadlessCodexWorkspaceStatusSnapshotForTest swaps the snapshot function
// for the duration of the test. Same race motivation as
// setPrepareTaskWorktreeForTest: the snapshot is read by the headless queue
// worker on a goroutine that can outlive the test's t.Cleanup.
func setHeadlessCodexWorkspaceStatusSnapshotForTest(t *testing.T, fn headlessCodexWorkspaceStatusSnapshotFn) {
	t.Helper()
	prior := headlessCodexWorkspaceStatusSnapshotOverride.Load()
	headlessCodexWorkspaceStatusSnapshotOverride.Store(&fn)
	t.Cleanup(func() {
		headlessCodexWorkspaceStatusSnapshotOverride.Store(prior)
	})
}

// setGraphRecordFactRefsForTest swaps the entity-graph fact-ref hook.
// Read by the broker HTTP handler goroutine in handleEntityFact.
func setGraphRecordFactRefsForTest(t *testing.T, fn graphRecordFactRefsFn) {
	t.Helper()
	prior := graphRecordFactRefsOverride.Load()
	graphRecordFactRefsOverride.Store(&fn)
	t.Cleanup(func() {
		graphRecordFactRefsOverride.Store(prior)
	})
}

// setStudioPackageGeneratorForTest swaps the Studio LLM dispatcher.
func setStudioPackageGeneratorForTest(t *testing.T, fn studioPackageGeneratorFn) {
	t.Helper()
	prior := studioPackageGeneratorOverride.Load()
	studioPackageGeneratorOverride.Store(&fn)
	t.Cleanup(func() {
		studioPackageGeneratorOverride.Store(prior)
	})
}

// setLauncherSendNotificationToPaneForTest swaps the pane notification
// dispatcher. Read by the pane-dispatch and resume goroutines.
func setLauncherSendNotificationToPaneForTest(t *testing.T, fn launcherSendNotificationToPaneFn) {
	t.Helper()
	prior := launcherSendNotificationToPaneOverride.Load()
	launcherSendNotificationToPaneOverride.Store(&fn)
	t.Cleanup(func() {
		launcherSendNotificationToPaneOverride.Store(prior)
	})
}

// setListHeadlessTaskRunnerProcessesForTest swaps the ps-listing seam used
// by killStaleHeadlessTaskRunners.
func setListHeadlessTaskRunnerProcessesForTest(t *testing.T, fn listHeadlessTaskRunnerProcessesFn) {
	t.Helper()
	prior := listHeadlessTaskRunnerProcessesOverride.Load()
	listHeadlessTaskRunnerProcessesOverride.Store(&fn)
	t.Cleanup(func() {
		listHeadlessTaskRunnerProcessesOverride.Store(prior)
	})
}

// setKillHeadlessTaskRunnerProcessForTest swaps the kill-by-PID seam.
func setKillHeadlessTaskRunnerProcessForTest(t *testing.T, fn killHeadlessTaskRunnerProcessFn) {
	t.Helper()
	prior := killHeadlessTaskRunnerProcessOverride.Load()
	killHeadlessTaskRunnerProcessOverride.Store(&fn)
	t.Cleanup(func() {
		killHeadlessTaskRunnerProcessOverride.Store(prior)
	})
}

// SeedLegacyRoomForTest gives a broker a channel literally named "general".
//
// Cross-package version of the in-package fixture helper, for teammcp and any
// other package whose tests need a room to post into. Those tests are not
// about #general -- they exercise tool surfaces, message scoping, and task
// plumbing, and they simply need somewhere for a bot to speak.
//
// The FIXTURE provides the room; PRODUCTION does not. This bypasses the create
// gate deliberately, and the seed paths that would mint #general in a real
// workspace stay gated behind generalChannelEnabled and are covered by their
// own tests. A test that cares whether #general EXISTS must not call this.
func SeedLegacyRoomForTest(b *Broker) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.findChannelLocked(GeneralChannelSlug) != nil {
		return
	}
	members := make([]string, 0, len(b.members)+1)
	members = append(members, "human")
	for _, m := range b.members {
		members = append(members, m.Slug)
	}
	b.channels = append(b.channels, teamChannel{
		Slug:        GeneralChannelSlug,
		Name:        GeneralChannelSlug,
		Type:        "channel",
		Description: "Legacy room provided by the test fixture only",
		Members:     members,
	})
}

// SeedBridgedRoomForTest gives a broker a BRIDGED room that several bots
// share — the shape of a Slack or Telegram channel wired into the office.
//
// Cross-package callers (teammcp) have routing tests — which channel does a
// broadcast default to, which room does a task action report in — that need a
// room holding more than two participants. Two other candidates do not work,
// and both failures are the product behaving correctly:
//
//   - A DM has exactly two members by definition, so the CEO tagging a
//     specialist inside another bot's DM is refused. That is the privacy
//     model, not a broken fixture.
//   - A plain named room can be seeded, but GET /channels WITHHOLDS ordinary
//     named rooms while the retirement switch is off, so it is invisible to
//     the bot-side channel inference these tests drive. The room would exist
//     and the routing would still resolve elsewhere.
//
// A bridged room is the multi-participant surface that survives the
// retirement, and it survives deliberately: it is how external messages
// arrive, so hiding it would strand every message that came in through it.
// Routing between bots in a shared room is exactly what still has to work
// there, which makes it the honest fixture rather than a way around the gate.
func SeedBridgedRoomForTest(b *Broker, slug string, members ...string) {
	if b == nil {
		return
	}
	slug = normalizeChannelSlug(slug)
	if slug == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.findChannelLocked(slug) != nil {
		return
	}
	b.channels = append(b.channels, teamChannel{
		Slug:        slug,
		Name:        slug,
		Type:        "channel",
		Description: "Bridged room provided by the test fixture only",
		Members:     uniqueSlugs(append([]string{"human", "ceo"}, members...)),
		Surface:     &channelSurface{Provider: "slack", RemoteID: "C" + strings.ToUpper(slug), RemoteTitle: slug},
	})
	b.rebuildChannelIndexLocked()
}

// HasChannelForTest reports whether the broker holds a channel with this slug.
//
// Cross-package existence check, for teammcp and anyone else asserting that a
// refused create really created nothing. It exists because GET /channels is no
// longer a usable proxy for that: with named channels retired the listing
// WITHHOLDS ordinary named rooms, so "the room is not in the response" is true
// whether or not it was created, and a test built on the listing would pass
// through the exact bug it guards. This reads the roster of rooms directly.
func HasChannelForTest(b *Broker, slug string) bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.findChannelLocked(slug) != nil
}
