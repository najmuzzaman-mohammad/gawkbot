package team

import (
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"
)

// broker_plan_approval.go wires the structured-planning approval gate. A task in
// LifecycleStatePlanning is dispatched read-only (see plan_mode.go); when that
// turn finishes with a plan, the broker raises ONE human_interview asking the
// human to approve the plan. Approving it transitions Planning→Running and
// dispatches the owner to execute — the single point at which sub-task creation
// and repo changes become legal for that work.

const planApprovalDedupePrefix = "plan-approval:"

// issueShouldPlanFirstLocked decides whether a freshly-created top-level Issue
// enters structured planning (Planning) before execution rather than landing
// straight in Running. The strong default: every top-level work Issue plans
// first, so the owner asks the human its genuine open questions, writes a single
// coherent plan, and gets it approved BEFORE any sub-tasks or repo changes —
// which is what stops the duplicate / shallow-subtask spray.
//
// Exemptions:
//   - sub-issues (ParentIssueID set): created from an already-approved parent
//     plan, so they execute directly.
//   - internal recovery actors (system/broker/nex): migration / fold-in /
//     self-heal paths must not stall on human plan approval.
//   - app-builder build/improve tasks (owner="app-builder"): the human's
//     description IS the authorization (they asked for "build X"), so a build
//     must not stall on a second plan-approval step — it would break the
//     "describe it, it builds" promise and gate every build iteration. The app
//     builder iterates by publishing versions, not by pre-approved plans.
//
// Caller holds b.mu.
func (b *Broker) issueShouldPlanFirstLocked(task *teamTask, actor string) bool {
	if task == nil {
		return false
	}
	if strings.TrimSpace(task.ParentIssueID) != "" {
		return false
	}
	if isInternalTaskActor(actor) {
		return false
	}
	if isAppBuilderSlug(task.Owner) {
		return false
	}
	if b.disablePlanFirstDefault {
		return false
	}
	return true
}

// requestIsPlanApproval reports whether a request is the plan-approval interview
// the broker raised for a planning task (DedupeKey "plan-approval:<taskID>").
func requestIsPlanApproval(req humanInterview) bool {
	return strings.HasPrefix(strings.TrimSpace(req.DedupeKey), planApprovalDedupePrefix)
}

// RaisePlanApproval surfaces a finished planning turn's plan for human approval.
// Safe to call from a runner goroutine: it takes b.mu, is idempotent (an active
// plan-approval interview for the task short-circuits), and persists. Returns
// the request id ("" when nothing was raised).
func (b *Broker) RaisePlanApproval(taskID, actor, plan string) string {
	if b == nil {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	id := b.raisePlanApprovalInterviewLocked(taskID, actor, plan)
	if id != "" {
		if err := b.saveLocked(); err != nil {
			log.Printf("broker: persist plan-approval interview for %q: %v", taskID, err)
		}
	}
	return id
}

// raisePlanApprovalInterviewLocked raises the plan-approval human_interview for a
// planning task. Idempotent on DedupeKey + on any active interview already linked
// to the task. No-op when the task is missing or not in Planning. Caller holds
// b.mu and is responsible for persistence.
func (b *Broker) raisePlanApprovalInterviewLocked(taskID, actor, plan string) string {
	task := b.taskByIDLocked(strings.TrimSpace(taskID))
	if task == nil || task.LifecycleState != LifecycleStatePlanning {
		return ""
	}
	dedupeKey := planApprovalDedupePrefix + task.ID
	for i := range b.requests {
		if !requestIsActive(b.requests[i]) {
			continue
		}
		if strings.TrimSpace(b.requests[i].DedupeKey) == dedupeKey {
			return b.requests[i].ID
		}
	}

	from := strings.TrimSpace(actor)
	if from == "" {
		from = strings.TrimSpace(task.Owner)
	}
	if from == "" {
		from = "office"
	}
	// The task's channel, else the owner's DM, else the asker's. This card is
	// BLOCKING: the bot stalls until it is answered, so filing it into the
	// retired "general" hangs the plan on an approval the human never sees.
	channel := normalizeChannelSlug(task.Channel)
	if strings.TrimSpace(task.Channel) == "" {
		if home, err := b.homeChannelForWriterLocked(from, task.Owner, from); err == nil {
			channel = home
		}
	}

	title := strings.TrimSpace(task.Title)
	if title == "" {
		title = task.ID
	}
	var qb strings.Builder
	// Lead with the decision in the human's terms: what they get, and what
	// happens either way. The old copy opened with the bot's framing
	// ("Plan ready for X. Review it and approve to start execution (the team
	// will create the sub-tasks…)") and then pasted 1200 characters of the
	// bot's own working plan — tool names, internal reasoning, and absolute
	// paths into the user's home directory. A human could not tell what it was
	// for or why it was their problem.
	fmt.Fprintf(&qb, "%s wants to start work on %s (%s).\n\n", ownerLabelForPlan(from), title, task.ID)
	qb.WriteString("Approve and they begin. Decline and nothing happens until you say otherwise.\n\n")
	if p := humanReadablePlanSummary(plan); p != "" {
		qb.WriteString("Their plan, in short:\n")
		qb.WriteString(p)
	} else {
		qb.WriteString("They have not written a plan summary yet.")
	}

	options, recommended := requestOptionDefaults("approval")
	now := time.Now().UTC().Format(time.RFC3339)
	b.counter++
	req := humanInterview{
		ID:            fmt.Sprintf("request-%d", b.counter),
		Kind:          "approval",
		Status:        "pending",
		From:          from,
		Channel:       channel,
		Title:         "Start work on " + title + "?",
		Question:      qb.String(),
		Options:       options,
		RecommendedID: recommended,
		DedupeKey:     dedupeKey,
		IssueID:       task.ID,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	b.scheduleRequestLifecycleLocked(&req)
	b.postRequestRaisedChatMessageLocked(&req)
	b.requests = append(b.requests, req)
	b.pendingInterview = firstBlockingRequest(b.requests)
	b.appendActionLocked("request_created", "office", channel, from,
		truncateSummary(req.Title+" "+req.Question, 140), req.ID)
	return req.ID
}

// startApprovedPlanTaskLocked transitions a planning task to Running and
// dispatches its owner — the structured-planning analogue of the human
// "approve = start" affordance for parked tasks. No-op unless the task is in
// Planning. Caller holds b.mu; persistence is the caller's responsibility.
func (b *Broker) startApprovedPlanTaskLocked(task *teamTask, actor string) {
	if b == nil || task == nil || task.LifecycleState != LifecycleStatePlanning {
		return
	}
	// Sync the worktree BEFORE flipping to Running so a failed sync never lands a
	// dispatched task on an unsynced tree (the mutation-service start path rolls
	// back on the same error). On failure leave the task in Planning — the
	// answered interview means the owner re-plans + re-raises on the next
	// dispatch — rather than dispatching execution against a broken worktree.
	if err := b.syncTaskWorktreeLocked(task); err != nil {
		log.Printf("broker: worktree sync for approved plan %q failed, staying in planning: %v", task.ID, err)
		return
	}
	if err := b.applyLifecycleStateLocked(task, LifecycleStateRunning); err != nil {
		log.Printf("broker: start approved plan %q: %v", task.ID, err)
		return
	}
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	// Raw emptiness first: a task with no home must not be laundered into
	// "general" here, because BOTH the promotion below and the audit write at
	// the end of this function would then land in the retired room.
	channel := ""
	if raw := strings.TrimSpace(task.Channel); raw != "" {
		channel = normalizeChannelSlug(raw)
	}
	if channel != "" {
		b.ensureTaskOwnerChannelMembershipLocked(channel, task.Owner)
	}
	b.queueTaskBehindActiveOwnerLaneLocked(task)
	b.scheduleTaskLifecycleLocked(task)
	if channel != "" {
		b.appendActionLocked("task_updated", "office", channel, actor,
			truncateSummary(task.Title+" [plan approved]", 140), task.ID)
	}
}

// applyPlanApprovalAnswerLocked is called from applyRequestAnswerLocked when a
// plan-approval interview is answered. An approve choice starts the task
// (Planning→Running + dispatch); any other choice (reject / needs-more-info)
// leaves the task in Planning so the owner can revise on the next notification.
// Caller holds b.mu.
func (b *Broker) applyPlanApprovalAnswerLocked(req humanInterview, answer *interviewAnswer, actor string) {
	if !requestIsPlanApproval(req) || answer == nil {
		return
	}
	if !strings.HasPrefix(strings.TrimSpace(answer.ChoiceID), "approve") {
		return
	}
	task := b.taskByIDLocked(strings.TrimSpace(req.IssueID))
	if task == nil {
		return
	}
	b.startApprovedPlanTaskLocked(task, actor)
}

// ownerLabelForPlan renders the requesting bot for a human audience.
func ownerLabelForPlan(slug string) string {
	slug = strings.TrimSpace(slug)
	if slug == "" || slug == "office" {
		return "The team"
	}
	return "@" + slug
}

// humanReadablePlanSummary turns a bot's working plan into something worth
// putting in front of a person.
//
// A bot writes its plan for itself: MCP tool names, step-by-step mechanics,
// and the absolute path of the plan file on disk. Pasted raw into an approval
// card that becomes noise the human has to decode before they can answer a
// yes/no question — and it leaks local filesystem paths into a shared surface.
//
// This keeps the substance and drops what only the bot needs: absolute paths
// are removed, and the whole thing is capped short enough to read at a glance.
// The full plan stays available on the task itself for anyone who wants it.
func humanReadablePlanSummary(plan string) string {
	p := strings.TrimSpace(plan)
	if p == "" {
		return ""
	}
	p = absolutePathPattern.ReplaceAllString(p, "the plan file")
	p = strings.Join(strings.Fields(p), " ")
	return truncateSummary(p, 500)
}

// absolutePathPattern matches POSIX-style absolute paths (optionally wrapped in
// backticks) so a plan summary never publishes where the file lives on the
// operator's machine.
var absolutePathPattern = regexp.MustCompile("`?/(?:Users|home|var|tmp|private|opt)/[^\\s`]*`?")
