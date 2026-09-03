package team

// The human-note machinery: how a human's message in a task's room becomes a
// halt the owning bot must acknowledge, and how that halt is cleared.
//
// Split out of broker_tasks_mutation_service.go, which had grown to 1719 lines
// and past the 1500-line budget. This is a pure move -- same package, same
// identifiers, no signature changed -- chosen over an allowlist entry because
// the cluster is genuinely cohesive: everything here is about one question,
// "has a human said stop, and has the bot seen it".
//
// It is also the file most actively edited during the channel retirement, so
// giving it a name it can be found by is worth more than the line count.

import (
	"fmt"
	"log"
	"strings"
	"time"
)

// humanNoteHaltClipChars bounds the note body stored on the task (and
// therefore rendered at the top of the next packet).
const humanNoteHaltClipChars = 2000

// humanNoteLeadsWithHalt reports whether a human message opens with a stop
// token ("stop", "wait", "hold" — covers "hold on") as its leading word.
func humanNoteLeadsWithHalt(content string) bool {
	fields := strings.FieldsFunc(strings.ToLower(strings.TrimSpace(content)), func(r rune) bool {
		return !(r >= 'a' && r <= 'z')
	})
	if len(fields) == 0 {
		return false
	}
	switch fields[0] {
	case "stop", "wait", "hold":
		return true
	}
	return false
}

// taskFollowUpActionKind is the action kind appended when a human posts
// into a DELIVERED task's channel. notifyTaskActionsLoop forwards it past
// the done-skip so the owner is re-engaged through the same wake path
// reopen uses (B1) — the structural fix for the post-done dead zone
// (ICP-eval v2 [01:48]/[01:58]: "make the tagline punchier" on a delivered
// task died in a 22-minute void).
const taskFollowUpActionKind = "task_followup"

// taskInTerminalDoneState reports whether the task sits in a delivered
// terminal state (done/approved) — the states where a later human post is a
// follow-up on shipped work rather than mid-flight steering. Archived tasks
// are excluded: the legacy channel fold-in parks orphaned chat under
// archived owner tasks that must never wake on lobby traffic.
func taskInTerminalDoneState(task *teamTask) bool {
	if task == nil || task.LifecycleState == LifecycleStateArchived {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(task.status), "done") ||
		task.LifecycleState == LifecycleStateApproved
}

// taskAwaitsHumanFollowUpWake reports whether a task sits in a waiting
// state where a human post in its channel must WAKE the owner (the
// task_followup path) because no naturally scheduled bot turn will ever
// carry the note: review, decision, changes_requested, blocked, and the
// terminal done/approved states. Pre-execution states (drafting/intake/
// ready/queued) are excluded — parked tasks stay parked until the human
// starts them, and ownerless tasks dispatch on assignment — and archived
// tasks never wake on channel traffic (legacy fold-ins).
func taskAwaitsHumanFollowUpWake(task *teamTask) bool {
	if task == nil {
		return false
	}
	switch task.LifecycleState {
	case LifecycleStateReview, LifecycleStateDecision,
		LifecycleStateChangesRequested, LifecycleStateBlocked:
		return true
	}
	if taskInTerminalDoneState(task) {
		return true
	}
	// Legacy tasks without a typed state: fall back to the bare status
	// signals for the same waiting states.
	if task.LifecycleState == "" || task.LifecycleState == LifecycleStateUnknown {
		switch strings.ToLower(strings.TrimSpace(task.status)) {
		case "review", "blocked":
			return true
		}
	}
	return false
}

// markHumanNoteOnChannelTasksLocked stamps HumanNotePending on every
// non-system task in the message's channel that is either RUNNING or in a
// terminal-done state. Called from the message-post paths for HUMAN senders
// only.
//
// Running tasks: the live failure this closes is ICP-eval v2 [00:50] — a
// typed "Stop — do not build a placeholder" was never seen by the mid-turn
// bot and the fabricated one-pager shipped anyway. Per-task channels make
// this 1:1 in practice; #general's archived system task is excluded by the
// status guard.
//
// Non-running tasks (done-integrity + utterance-routing fix families): a
// human post into a task channel whose task sits in ANY waiting state —
// review, decision, changes_requested, blocked, or terminal done/approved —
// is steering with no natural next bot turn to ride. The note is stamped
// the same way AND a task_followup action is appended so the notify loop
// re-engages the OWNER (ICP-eval v3 [17:51→18:02]: redlines posted into a
// decision-state task channel got 14 minutes of dead air; v2's 22-minute
// post-done void was the same failure on done tasks).
//
// This used to be restricted to non-#general channels, on the reasoning that
// #general was a lobby holding legacy done tasks and waking all their owners on
// any lobby post would be a broadcast storm. The one-room change inverted that
// premise: every task now lives in #general, so the guard silently disabled the
// wake for the entire product — a human could post a redline on a task in
// review and nothing would ever pick it up. That is the exact dead-air failure
// this mechanism exists to prevent, reintroduced everywhere at once.
//
// The guard is replaced by an ADDRESSING test rather than deleted, because
// deleting it really would produce the storm the original comment feared. In a
// shared room a message wakes the task it actually addresses — a reply in the
// task's thread, or an explicit task id in the text. A dedicated (non-general)
// channel keeps the old channel-wide behaviour, since there the room itself is
// the address.
//
// The same rule governs which running tasks receive the note, with one
// deliberate exception: a message that leads with a halt reaches EVERY running
// task in the room. In a one-room office, a human typing "stop" is addressing
// the whole team, and honouring that is worth the breadth.
//
// Parked (drafting) tasks stay parked until the human starts them, and
// archived tasks never wake on lobby traffic.
//
// Pure in-memory writes under the already-held lock — the caller's
// saveLocked persists them. Caller must hold b.mu.
func (b *Broker) markHumanNoteOnChannelTasksLocked(msg channelMessage) {
	if !isHumanMessageSender(msg.From) || strings.TrimSpace(msg.Content) == "" {
		return
	}
	channel := normalizeChannelSlug(msg.Channel)
	if channel == "" {
		channel = "general"
	}
	now := strings.TrimSpace(msg.Timestamp)
	if now == "" {
		now = time.Now().UTC().Format(time.RFC3339)
	}
	// Is the room the address, or must the message name its target?
	//
	// SCOPED TO DMs ON PURPOSE. The obvious version of this counts tasks in
	// EVERY room, and it is wrong — two existing tests prove it, and they fail
	// in opposite directions, so no task-count rule alone can satisfy both:
	//
	//   TestHumanNoteWakesOwnerOnWaitingTaskStates puts SIX tasks in the named
	//   room "task-acme" and expects an unaddressed human post to reach four of
	//   them. A universal count makes that room shared and reaches none.
	//
	//   TestTaskFollowUp_GeneralAndArchivedAndAgentPostsExcluded puts ONE done
	//   task in #general and expects it NOT to be marked, because the lobby is
	//   never an address. A universal count makes a one-task room addressable
	//   and marks it.
	//
	// So named rooms and #general keep exactly today's behaviour, and only DMs
	// get the count. That is also the only case that actually needed fixing: a
	// DM with one bot can easily accumulate a dozen tasks, and without this
	// every casual human line would stamp all of them.
	//
	// DO NOT "simplify" this into the universal version. That is the change
	// that was tried and reverted; the two tests named above are the evidence.
	//
	// It also survives the #general retirement, which the old
	// `channel == "general"` proxy did not: that would have gone permanently
	// false, making namedThisTask below permanently TRUE and restoring the
	// broadcast storm this function exists to prevent. After the flip, DMs are
	// the only rooms left and the count is the whole rule.
	sharedRoom := channel == GeneralChannelSlug
	if IsDMSlug(channel) {
		tasksInRoom := 0
		for i := range b.tasks {
			if b.tasks[i].System {
				continue
			}
			if normalizeChannelSlug(b.tasks[i].Channel) != channel {
				continue
			}
			tasksInRoom++
		}
		sharedRoom = tasksInRoom > 1
	}
	halting := humanNoteLeadsWithHalt(msg.Content)
	for i := range b.tasks {
		task := &b.tasks[i]
		if task.System {
			continue
		}
		if normalizeChannelSlug(task.Channel) != channel {
			continue
		}
		// "Running" means an execution turn can naturally carry the note:
		// the typed Running state, or a legacy task whose only signal is
		// status=in_progress. Review/Decision/ChangesRequested ALSO carry
		// the legacy in_progress status (lifecycleDerivedFields) but have
		// NO natural next turn — they must take the wake path below, so
		// the typed state wins over the legacy status here.
		running := task.LifecycleState == LifecycleStateRunning ||
			(task.LifecycleState == "" && strings.EqualFold(strings.TrimSpace(task.status), "in_progress"))

		// When the room holds exactly one task the room itself is the address.
		// When it holds several, the message has to name its target.
		//
		// The halt exception is deliberately NARROW: it reaches every RUNNING
		// task, because a human typing "stop" in the team's one room means stop
		// what you are doing. It does NOT reach waiting tasks. Widening it
		// there would stamp a note on work that is already finished or already
		// waiting on the human — there is nothing for them to stop, and the
		// note would wake their owners for nothing. An earlier version of this
		// check ran before the running/waiting split and did exactly that.
		namedThisTask := !sharedRoom || messageAddressesTask(msg, task)
		if running {
			if !namedThisTask && !halting {
				continue
			}
		} else if !namedThisTask {
			continue
		}

		followUp := !running &&
			taskAwaitsHumanFollowUpWake(task) && strings.TrimSpace(task.Owner) != ""
		if !running && !followUp {
			continue
		}
		// Fresh struct every time (rollback safety; see TaskHumanNote).
		task.HumanNotePending = &TaskHumanNote{
			From: strings.TrimSpace(msg.From),
			Body: truncate(strings.TrimSpace(msg.Content), humanNoteHaltClipChars),
			At:   now,
			Halt: humanNoteLeadsWithHalt(msg.Content),
		}
		if followUp {
			summary := "human follow-up on delivered task: "
			if !taskInTerminalDoneState(task) {
				summary = "human posted in waiting task's channel: "
			}
			b.appendActionLocked(taskFollowUpActionKind, "office", channel, strings.TrimSpace(msg.From),
				truncateSummary(summary+strings.TrimSpace(msg.Content), 140), task.ID)
		}
	}
}

// ConsumeTaskHumanNote clears the pending human note on a task. Called by
// the packet builder when the owner's next packet has rendered the note —
// consumption is "the packet carried it", which also releases the halt gate
// on submit_for_review/complete.
func (b *Broker) ConsumeTaskHumanNote(taskID string) {
	taskID = strings.TrimSpace(taskID)
	if b == nil || taskID == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	task := b.findTaskByIDLocked(taskID)
	if task == nil || task.HumanNotePending == nil {
		return
	}
	task.HumanNotePending = nil
	if err := b.saveLocked(); err != nil {
		log.Printf("task %s: persist human-note consumption: %v", taskID, err)
	}
}

// humanNoteHaltMessage names the unread stop order in the forbidden error
// so the blocked bot knows exactly why the transition is refused.
func humanNoteHaltMessage(taskID, action string, note *TaskHumanNote) string {
	excerpt := strings.TrimSpace(note.Body)
	if len(excerpt) > 280 {
		excerpt = excerpt[:277] + "..."
	}
	return fmt.Sprintf(
		"cannot %s %s: the human posted a stop order in this task's channel at %s that you have not yet processed: %q. Read it, address it, and wait for your next work packet (which carries the note) before retrying.",
		action, taskID, note.At, excerpt,
	)
}
