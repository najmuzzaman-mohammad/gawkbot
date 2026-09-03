package team

import (
	"context"
	"strings"
)

// Per-task runtime resolution.
//
// The LLM provider + model are a property of the TASK, not the bot — an
// bot is a persona that can run different tasks on different models, and (per
// the parallel-instances change) several at once. Dispatch therefore prefers
// the running turn's task Provider/Model over the owner bot's binding (now
// only a soft default), which itself falls back to the install-wide default.
// Effort is resolved the same way in headless_effort.go.
//
// The provider+model are chosen together in the composer, so a task that sets a
// Model also sets a Provider. taskModelForKind only returns the task's model
// when the task's provider matches the runtime asking — this prevents a codex
// task's model id from leaking into the claude runner (and vice versa) when the
// bot's own binding routed the turn.
//
// ── Per-turn task identity ──────────────────────────────────────────────
// A bot can run several tasks concurrently, so "the bot's active task" is
// ambiguous on the execution path. Every headless turn carries its task id; we
// stash it on the turn's context.Context (set in beginHeadlessCodexTurn) so the
// runtime helpers below resolve the SPECIFIC task the turn is for, rather than
// guessing via botActiveTask(slug) (which returns the first in_progress task
// — wrong once a bot owns more than one). Callers off the headless path
// (e.g. the interactive pane builder) pass a background context and fall back
// to botActiveTask, which is correct there because panes are single-task.

type headlessTurnTaskIDKey struct{}

// withHeadlessTurnTaskID returns ctx tagged with the executing turn's task id.
// Empty ids are a no-op so chat turns (no task) don't shadow the fallback.
func withHeadlessTurnTaskID(ctx context.Context, taskID string) context.Context {
	taskID = strings.TrimSpace(taskID)
	if ctx == nil || taskID == "" {
		return ctx
	}
	return context.WithValue(ctx, headlessTurnTaskIDKey{}, taskID)
}

// headlessTurnTaskID reads the executing turn's task id off ctx, or "" when the
// caller is not on a tagged headless turn.
func headlessTurnTaskID(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if id, ok := ctx.Value(headlessTurnTaskIDKey{}).(string); ok {
		return strings.TrimSpace(id)
	}
	return ""
}

// turnTaskForCtx resolves the task a turn is running, preferring the turn's
// task id carried on ctx over the legacy "first in_progress task for slug"
// lookup. With parallel instances botActiveTask(slug) alone is ambiguous; the
// ctx task id disambiguates. Falls back to botActiveTask when ctx carries no
// id (chat turns, the pane path) so existing single-task callers are unchanged.
func (l *Launcher) turnTaskForCtx(ctx context.Context, slug string) *teamTask {
	if l == nil || l.broker == nil {
		return nil
	}
	if id := headlessTurnTaskID(ctx); id != "" {
		if task := l.broker.TaskByID(id); task != nil {
			return task
		}
	}
	return l.botActiveTask(slug)
}

// raisePlanApprovalAfterTurn surfaces a finished planning turn's plan for human
// approval via the broker. No-op when the task is no longer in Planning (already
// approved/changed) or the broker is unavailable. plan is the harvested plan
// text used as the approval question's context.
func (l *Launcher) raisePlanApprovalAfterTurn(taskID, slug, plan string) {
	if l == nil || l.broker == nil || strings.TrimSpace(taskID) == "" {
		return
	}
	// A planning turn that produced no plan (timed out, crashed, or was blocked
	// before writing anything) must NOT raise a vacuous "approve this empty
	// plan" gate the human could click through. Skip it; the task stays in
	// Planning and the stall watchdog surfaces the silent owner. Re-raise
	// happens on the next dispatch once a real plan exists (idempotent).
	if strings.TrimSpace(plan) == "" {
		return
	}
	l.broker.RaisePlanApproval(taskID, slug, plan)
}

// maybeQueueInlineDetection fires inline workflow→App detection after a turn that
// was NOT attributed to a real task — the only case the post-task detection hook
// misses. A task-attributed turn is handled when its task reaches done, so this
// returns early for those. Best-effort and gated inside the broker.
func (l *Launcher) maybeQueueInlineDetection(ctx context.Context, slug string, channel ...string) {
	if l == nil || l.broker == nil || !l.broker.workflowDetectionEnabled {
		return // cheapest gate first: with detection off, skip the task-id lookup
	}
	if strings.TrimSpace(l.turnTaskIDForCtx(ctx, slug)) != "" {
		return // task turn — the reachedDone hook owns detection for it
	}
	l.broker.queueInlineWorkflowDetection(slug, firstNonEmpty(channel...))
}

// turnTaskIDForCtx returns the running turn's task id, preferring the id carried
// on ctx over the legacy botActiveTaskID(slug) lookup. Used for stream/event
// labelling so each parallel instance's output is tagged with its own task.
func (l *Launcher) turnTaskIDForCtx(ctx context.Context, slug string) string {
	if id := headlessTurnTaskID(ctx); id != "" {
		return id
	}
	return l.botActiveTaskID(slug)
}

// effectiveProviderKindForBot picks the runtime kind for slug's current turn,
// preferring the turn task's per-task provider over the bot binding / global
// default. The dispatch switch uses it to route to the right runner.
func (l *Launcher) effectiveProviderKindForBot(ctx context.Context, slug string) string {
	if l == nil {
		return ""
	}
	if task := l.turnTaskForCtx(ctx, slug); task != nil {
		if kind := strings.TrimSpace(task.Provider); kind != "" {
			return normalizeProviderKind(kind)
		}
	}
	return l.targeter().MemberEffectiveProviderKind(slug)
}

// taskModelForKind returns the turn task's per-task model when the task's
// provider matches kind, else "" (let the caller fall back to the binding /
// runtime default). Matching on kind keeps a codex task's model out of the
// claude runner and vice versa.
func (l *Launcher) taskModelForKind(ctx context.Context, slug, kind string) string {
	if l == nil {
		return ""
	}
	task := l.turnTaskForCtx(ctx, slug)
	if task == nil {
		return ""
	}
	if normalizeProviderKind(strings.TrimSpace(task.Provider)) != normalizeProviderKind(kind) {
		return ""
	}
	return strings.TrimSpace(task.Model)
}
