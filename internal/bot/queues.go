package bot

import "sync"

// MessageQueues manages per-bot message queues.
//
// Three queues are maintained per bot:
//
//   - steerQueues:    system-level course corrections (e.g. team-lead delegations)
//   - humanQueues:    high-priority messages from a real person; drained before
//     follow-ups so the bot absorbs human input before resuming
//     any prior bot-originated task
//   - followUpQueues: ordinary bot-to-bot follow-ups
type MessageQueues struct {
	mu             sync.Mutex
	steerQueues    map[string][]string
	humanQueues    map[string][]string
	followUpQueues map[string][]string
}

// NewMessageQueues creates an empty MessageQueues.
func NewMessageQueues() *MessageQueues {
	return &MessageQueues{
		steerQueues:    make(map[string][]string),
		humanQueues:    make(map[string][]string),
		followUpQueues: make(map[string][]string),
	}
}

// Steer enqueues a steering message for the given bot.
func (q *MessageQueues) Steer(botSlug, message string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.steerQueues[botSlug] = append(q.steerQueues[botSlug], message)
}

// Human enqueues a human-priority message for the given bot. Drained before
// follow-ups so a person's input is absorbed before the bot resumes any
// prior bot-originated task.
func (q *MessageQueues) Human(botSlug, message string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.humanQueues[botSlug] = append(q.humanQueues[botSlug], message)
}

// FollowUp enqueues a follow-up message for the given bot.
func (q *MessageQueues) FollowUp(botSlug, message string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.followUpQueues[botSlug] = append(q.followUpQueues[botSlug], message)
}

// DrainSteer removes and returns the front steer message for the bot.
// Returns ("", false) if the queue is empty.
func (q *MessageQueues) DrainSteer(botSlug string) (string, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	msgs := q.steerQueues[botSlug]
	if len(msgs) == 0 {
		return "", false
	}
	msg := msgs[0]
	q.steerQueues[botSlug] = msgs[1:]
	return msg, true
}

// DrainHuman removes and returns the front human-priority message for the bot.
// Returns ("", false) if the queue is empty.
func (q *MessageQueues) DrainHuman(botSlug string) (string, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	msgs := q.humanQueues[botSlug]
	if len(msgs) == 0 {
		return "", false
	}
	msg := msgs[0]
	q.humanQueues[botSlug] = msgs[1:]
	return msg, true
}

// DrainFollowUp removes and returns the front follow-up message for the bot.
// Returns ("", false) if the queue is empty.
func (q *MessageQueues) DrainFollowUp(botSlug string) (string, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	msgs := q.followUpQueues[botSlug]
	if len(msgs) == 0 {
		return "", false
	}
	msg := msgs[0]
	q.followUpQueues[botSlug] = msgs[1:]
	return msg, true
}

// HasSteer reports whether the bot has any steer messages queued.
func (q *MessageQueues) HasSteer(botSlug string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.steerQueues[botSlug]) > 0
}

// HasHuman reports whether the bot has any human-priority messages queued.
func (q *MessageQueues) HasHuman(botSlug string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.humanQueues[botSlug]) > 0
}

// HasFollowUp reports whether the bot has any follow-up messages queued.
func (q *MessageQueues) HasFollowUp(botSlug string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.followUpQueues[botSlug]) > 0
}

// HasMessages reports whether the bot has any queued messages (steer, human,
// or follow-up).
func (q *MessageQueues) HasMessages(botSlug string) bool {
	return q.HasSteer(botSlug) || q.HasHuman(botSlug) || q.HasFollowUp(botSlug)
}
