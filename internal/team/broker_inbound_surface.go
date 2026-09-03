package team

import (
	"fmt"
	"strings"
	"time"
)

func (b *Broker) postInboundSurfaceMessage(from, channel, content, provider, threadRootKey string) (channelMessage, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	// Raw emptiness before normalising: "" became "general", so this "channel
	// required" error was unreachable and an inbound surface message with no
	// destination was posted into the shared room.
	if strings.TrimSpace(channel) == "" {
		return channelMessage{}, fmt.Errorf("channel required for surface message")
	}
	channel = normalizeChannelSlug(channel)
	if b.findChannelLocked(channel) == nil {
		if IsDMSlug(channel) {
			if dm := b.ensureDMConversationLocked(channel); dm != nil {
				channel = dm.Slug
			}
		} else {
			return channelMessage{}, fmt.Errorf("%w: %s", ErrChannelNotFound, channel)
		}
		// DM auto-create can fail (returns nil): ensureDMConversationLocked
		// gives up whenever the slug has no resolvable participant — the bare
		// "dm-" is enough to reach it. Re-check before proceeding so we never
		// post into a non-existent channel. Same guard, same reason, as
		// handlePostMessage in broker_messages.go; this path is the sibling
		// that was missing it, so a surface inbound addressed to an
		// unresolvable DM appended a message to a room nobody can read
		// instead of failing.
		if b.findChannelLocked(channel) == nil {
			return channelMessage{}, fmt.Errorf("%w: %s", ErrChannelNotFound, channel)
		}
	}
	b.counter++
	msg := channelMessage{
		ID:          fmt.Sprintf("msg-%d", b.counter),
		From:        from,
		Channel:     channel,
		Kind:        "surface",
		Source:      provider,
		SourceLabel: provider,
		Content:     strings.TrimSpace(content),
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
	}
	// Thread mapping: a reply inside a task's Slack thread is folded into that
	// task's internal thread so the task context (and only that task) sees it.
	// Set before appendMessageLocked, whose owner-based auto-stamp does NOT
	// fire for non-owner foreign bots or humans — the thread is the only
	// signal that ties their reply to the task.
	// Scope the fold to Slack and to the message's own channel: the root key is
	// a Slack thread_ts, so a non-Slack inbound (Telegram reply_to, etc.) or a
	// reply that lands in a different channel must never be folded into a Slack
	// task thread by a key collision or replay.
	if provider == "slack" {
		if root := b.slackTaskByRootTSLocked(threadRootKey); root != nil &&
			normalizeChannelSlug(root.Channel) == channel {
			msg.SourceTaskID = root.ID
			if strings.TrimSpace(msg.ReplyTo) == "" && strings.TrimSpace(root.ThreadID) != "" {
				msg.ReplyTo = strings.TrimSpace(root.ThreadID)
			}
		}
	}
	// Promote @slug mentions into tags, mirroring handlePostMessage's
	// auto-promote: surface humans (Slack/Telegram) expect "@bot" to
	// notify exactly like web humans do. Same lead-routing guard as the web
	// path: when the lead is mentioned, do NOT fan out to other mentioned
	// bots — the human's intent is for the lead to route.
	if b.senderMayAutoPromoteLocked(from) {
		mentioned := extractMentionedSlugs(msg.Content)
		leadSlug := officeLeadSlugFrom(b.members)
		leadMentioned := leadSlug != "" && containsString(mentioned, leadSlug)
		for _, slug := range mentioned {
			if b.findMemberLocked(slug) == nil {
				continue
			}
			if leadMentioned && slug != leadSlug {
				continue
			}
			if !containsString(msg.Tagged, slug) {
				msg.Tagged = append(msg.Tagged, slug)
			}
		}
	}
	msg = b.appendMessageLocked(msg)
	// Mark as already delivered so it doesn't bounce back to the same surface
	if b.externalDelivered == nil {
		b.externalDelivered = make(map[string]struct{})
	}
	b.externalDelivered[msg.ID] = struct{}{}
	if err := b.saveLocked(); err != nil {
		return channelMessage{}, err
	}
	return msg, nil
}
