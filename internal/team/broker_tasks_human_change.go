package team

import (
	"fmt"
	"strings"
	"time"
)

// postHumanTaskChangeLocked announces a human's manual task edit in the channel
// and wakes the task's owner to respond to it.
//
// Why: editing a task in the Tasks surface used to be silent to the team. The
// broker recorded an activity-log line ("task_updated") that nobody reads and
// no bot is notified by, so a human who changed a status, retitled a task, or
// rewrote its description got no acknowledgement and no reaction — the office
// simply did not know. Every other way a human addresses the team (a message, a
// mention, an approval) reaches a bot; a task edit should too.
//
// What it does: posts one message into the task's channel naming the change,
// @-tagging the owner (the CEO when a task has none) so the owner wakes and
// responds. The channel is the task's channel, which since the one-room change
// is the channel the task was created from — #general — where the whole roster
// is present.
//
// Deliberately quiet about changes that already speak for themselves: reassign,
// cancel, request-changes, and reject each post their own richer notification,
// and bot-initiated edits are the bots doing their job, not news. Only a
// human's edit, and only when it actually changed something, produces a line.
//
// Caller MUST hold b.mu for write.
func (b *Broker) postHumanTaskChangeLocked(actor string, task *teamTask, changes []string) {
	if task == nil || len(changes) == 0 {
		return
	}
	if !isHumanMessageSender(actor) {
		return
	}

	channel := normalizeChannelSlug(task.Channel)
	if channel == "" {
		channel = "general"
	}

	owner := strings.TrimSpace(task.Owner)
	if owner == "" || b.findMemberLocked(owner) == nil {
		owner = "ceo"
	}

	now := time.Now().UTC().Format(time.RFC3339)
	title := strings.TrimSpace(task.Title)
	if title == "" {
		title = task.ID
	}

	b.counter++
	b.appendMessageLocked(channelMessage{
		ID:      fmt.Sprintf("msg-%d", b.counter),
		From:    strings.TrimSpace(actor),
		Channel: channel,
		Kind:    "task_changed",
		Title:   title,
		Content: fmt.Sprintf(
			"Updated %s (%s): %s. @%s — you own this: react if it changes your plan, otherwise carry on.",
			task.ID, title, strings.Join(changes, "; "), owner,
		),
		Tagged:    []string{owner},
		Timestamp: now,
	})
}

// describeTaskChanges renders the human-visible diff of a task edit. Returns an
// empty slice when nothing a person would care about actually moved, so the
// caller stays silent rather than posting "nothing changed".
//
// Values are truncated: a rewritten multi-paragraph description becomes
// "description rewritten" rather than dumping the whole body into the channel.
func describeTaskChanges(prev, next *teamTask) []string {
	if prev == nil || next == nil {
		return nil
	}
	var out []string
	if p, n := strings.TrimSpace(prev.Title), strings.TrimSpace(next.Title); p != n {
		out = append(out, fmt.Sprintf("title -> %q", truncateSummary(n, 80)))
	}
	if p, n := strings.TrimSpace(prev.status), strings.TrimSpace(next.status); p != n {
		out = append(out, fmt.Sprintf("status %s -> %s", statusLabelOrNone(p), statusLabelOrNone(n)))
	}
	if p, n := strings.TrimSpace(prev.Owner), strings.TrimSpace(next.Owner); p != n {
		out = append(out, fmt.Sprintf("owner %s -> %s", ownerLabelOrNone(p), ownerLabelOrNone(n)))
	}
	if p, n := strings.TrimSpace(prev.Details), strings.TrimSpace(next.Details); p != n {
		switch {
		case p == "":
			out = append(out, "description added")
		case n == "":
			out = append(out, "description cleared")
		default:
			out = append(out, "description rewritten")
		}
	}
	return out
}

func statusLabelOrNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

func ownerLabelOrNone(s string) string {
	if s == "" {
		return "(unassigned)"
	}
	return "@" + s
}
