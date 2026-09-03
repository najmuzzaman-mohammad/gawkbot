package teammcp

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
)

func normalizeChannelInput(input string) string {
	channel := strings.TrimSpace(input)
	if channel == "" {
		return ""
	}
	channel = strings.ToLower(strings.ReplaceAll(channel, " ", "-"))
	return channel
}

func resolveChannelHint(input string) string {
	channel := normalizeChannelInput(input)
	if channel == "" {
		channel = normalizeChannelInput(os.Getenv("WUPHF_CHANNEL"))
	}
	if channel == "" {
		channel = normalizeChannelInput(os.Getenv("NEX_CHANNEL"))
	}
	return channel
}

// resolveChannel answers "which channel does this MCP call address?" when the
// caller gave no explicit one.
//
// It used to answer "general". That is the single highest-fanout wrong answer
// in this package — it is the destination resolver behind every bot-initiated
// write here (actions.go, the channel tools, the wiki tools, the audit log), and
// with the shared room retired all of them addressed a channel that no longer
// exists.
//
// The right answer is the bot's OWN DM with the human. This process IS one
// bot: the launcher stamps its identity into WUPHF_AGENT_SLUG, so the
// conversation it belongs to is never ambiguous.
//
// When even that is unknown the answer is "" — not a guessed room. An empty
// channel is refused by the broker with a clear error, which is the correct
// outcome for a write nobody can address; inventing a room would put it
// somewhere nobody reads, which is the leak the retirement closes.
func resolveChannel(input string) string {
	if hint := resolveChannelHint(input); hint != "" {
		return hint
	}
	if slug := trustedEnvBotSlug(); slug != "" {
		return channel.DirectSlug("human", slug)
	}
	return ""
}

// resolveChannelForBot is resolveChannel for callers that already know WHICH
// bot they are resolving for.
//
// resolveChannel can only consult WUPHF_AGENT_SLUG, which the launcher sets on
// a real bot process but which is absent whenever the slug arrives as a tool
// ARGUMENT instead (my_slug=...). In that case resolveChannel has no identity
// to work from and correctly returns "" — but the caller here does have one, so
// falling back to the env would throw away the better answer.
func resolveChannelForBot(input, slug string) string {
	if hint := resolveChannelHint(input); hint != "" {
		return hint
	}
	if s := strings.TrimSpace(slug); s != "" {
		return channel.DirectSlug("human", s)
	}
	return resolveChannel(input)
}

func resolveConversationChannel(ctx context.Context, slug string, requestedChannel string) string {
	return resolveConversationContext(ctx, slug, requestedChannel, "").Channel
}

func resolveConversationContext(ctx context.Context, slug, requestedChannel, requestedReplyTo string) conversationContext {
	channel := resolveChannelHint(requestedChannel)
	replyTo := strings.TrimSpace(requestedReplyTo)
	if channel != "" {
		if replyTo == "" {
			replyTo = defaultReplyTargetForChannel(ctx, slug, channel)
		}
		return conversationContext{Channel: channel, ReplyToID: replyTo, Source: "explicit_channel"}
	}

	if replyTo != "" {
		if located := findMessageContextByID(ctx, slug, replyTo); located.Channel != "" {
			located.ReplyToID = replyTo
			located.Source = "explicit_reply"
			return located
		}
	}

	if isOneOnOneMode() {
		channel = resolveChannelForBot("", slug)
		if replyTo == "" {
			replyTo = inferDirectReplyTarget(ctx, slug, channel)
		}
		return conversationContext{Channel: channel, ReplyToID: replyTo, Source: "direct_session"}
	}

	if inferred := inferRecentConversationContext(ctx, slug); inferred.Channel != "" {
		if replyTo != "" {
			inferred.ReplyToID = replyTo
		}
		if inferred.ReplyToID == "" {
			inferred.ReplyToID = defaultReplyTargetForChannel(ctx, slug, inferred.Channel)
		}
		return inferred
	}

	if inferred := inferTaskConversationContext(ctx, slug); inferred.Channel != "" {
		if replyTo != "" {
			inferred.ReplyToID = replyTo
		}
		if inferred.ReplyToID == "" {
			inferred.ReplyToID = defaultReplyTargetForChannel(ctx, slug, inferred.Channel)
		}
		return inferred
	}

	channel = resolveChannelForBot("", slug)
	if replyTo == "" {
		replyTo = defaultReplyTargetForChannel(ctx, slug, channel)
	}
	return conversationContext{Channel: channel, ReplyToID: replyTo, Source: "fallback"}
}

// fetchAccessibleChannels lists the channels a bot can see, DMs included.
//
// Two calls, not one. GET /channels treats `type` as an EXCLUSIVE filter
// (broker_office_channels.go handleChannels): the default listing returns only
// non-DM channels and `?type=dm` returns only DMs. Without the second call an
// bot woken in a DM could not see the DM it was standing in — it had no way
// to name its own conversation. Asking for `?type=dm` alone would have swapped
// one blind spot for a worse one, dropping every real channel from wiki-link
// resolution and channel inference.
func fetchAccessibleChannels(ctx context.Context, slug string) []brokerChannelSummary {
	var channels []brokerChannelSummary
	var result brokerChannelsResponse
	regularErr := brokerGetJSON(ctx, "/channels", &result)
	if regularErr == nil {
		channels = append(channels, result.Channels...)
	}

	var dmResult brokerChannelsResponse
	dmErr := brokerGetJSON(ctx, "/channels?type=dm", &dmResult)
	if dmErr == nil {
		channels = append(channels, dmResult.Channels...)
	}

	// Both legs failing is a broker problem, and returning nil keeps the old
	// contract callers already handle. One leg failing still yields a usable
	// (if partial) view, which beats blanking the bot's whole world.
	if regularErr != nil && dmErr != nil {
		return nil
	}

	// The two listings are disjoint today (the handler's filter is exclusive),
	// but dedupe by slug so a future handler change cannot double-list a
	// channel into the bot's context packet.
	seen := make(map[string]bool, len(channels))
	deduped := make([]brokerChannelSummary, 0, len(channels))
	for _, ch := range channels {
		key := strings.ToLower(strings.TrimSpace(ch.Slug))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		deduped = append(deduped, ch)
	}

	slug = strings.TrimSpace(slug)
	if slug == "" || slug == "ceo" {
		return deduped
	}
	out := make([]brokerChannelSummary, 0, len(deduped))
	for _, ch := range deduped {
		if !contains(ch.Members, slug) || contains(ch.Disabled, slug) {
			continue
		}
		out = append(out, ch)
	}
	return out
}

func fetchChannelMessages(ctx context.Context, channel, slug, scope string, limit int) []brokerMessage {
	values := url.Values{}
	values.Set("channel", channel)
	if limit > 0 {
		values.Set("limit", fmt.Sprintf("%d", limit))
	}
	slug = strings.TrimSpace(slug)
	if slug != "" {
		values.Set("my_slug", slug)
		values.Set("viewer_slug", slug)
		if strings.TrimSpace(scope) != "" {
			values.Set("scope", strings.TrimSpace(scope))
		}
	}
	var result brokerMessagesResponse
	path := "/messages?" + values.Encode()
	if err := brokerGetJSON(ctx, path, &result); err != nil {
		return nil
	}
	return result.Messages
}

func inferRecentConversationContext(ctx context.Context, slug string) conversationContext {
	channels := fetchAccessibleChannels(ctx, slug)
	var (
		best      conversationContext
		bestStamp time.Time
	)
	for _, ch := range channels {
		messages := fetchChannelMessages(ctx, ch.Slug, slug, "inbox", 40)
		if len(messages) == 0 {
			continue
		}
		candidate, stamp := latestRelevantMessageContext(messages, slug, ch.Slug)
		if candidate.Channel == "" || stamp.IsZero() {
			continue
		}
		if best.Channel == "" || stamp.After(bestStamp) {
			best = candidate
			bestStamp = stamp
		}
	}
	return best
}

func latestRelevantMessageContext(messages []brokerMessage, slug, fallbackChannel string) (conversationContext, time.Time) {
	byID := make(map[string]brokerMessage, len(messages))
	for _, msg := range messages {
		if id := strings.TrimSpace(msg.ID); id != "" {
			byID[id] = msg
		}
	}
	for i := len(messages) - 1; i >= 0; i-- {
		msg := messages[i]
		if strings.TrimSpace(msg.From) == strings.TrimSpace(slug) {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(msg.Content), "[STATUS]") {
			continue
		}
		stamp, err := time.Parse(time.RFC3339, strings.TrimSpace(msg.Timestamp))
		if err != nil {
			continue
		}
		// Local is `ch`, not `channel`, so the channel package stays reachable.
		ch := normalizeChannelInput(msg.Channel)
		if ch == "" {
			ch = normalizeChannelInput(fallbackChannel)
		}
		if ch == "" && strings.TrimSpace(slug) != "" {
			// This bot's own DM with the human. Was "general": a reply to a
			// message whose channel we could not read went to the retired
			// shared room instead of back to the conversation it came from.
			ch = channel.DirectSlug("human", strings.TrimSpace(slug))
		}
		return conversationContext{
			Channel:   ch,
			ReplyToID: threadTargetForMessage(msg, byID),
			Source:    "recent_message",
		}, stamp
	}
	return conversationContext{}, time.Time{}
}

func threadTargetForMessage(msg brokerMessage, byID map[string]brokerMessage) string {
	current := strings.TrimSpace(msg.ID)
	parent := strings.TrimSpace(msg.ReplyTo)
	if parent == "" {
		return current
	}
	seen := map[string]bool{}
	for parent != "" {
		if seen[parent] {
			return parent
		}
		seen[parent] = true
		next, ok := byID[parent]
		if !ok || strings.TrimSpace(next.ReplyTo) == "" {
			return parent
		}
		parent = strings.TrimSpace(next.ReplyTo)
	}
	return current
}

func inferTaskConversationContext(ctx context.Context, slug string) conversationContext {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return conversationContext{}
	}
	channels := fetchAccessibleChannels(ctx, slug)
	var (
		best      conversationContext
		bestStamp time.Time
	)
	for _, ch := range channels {
		values := url.Values{}
		values.Set("channel", ch.Slug)
		values.Set("viewer_slug", slug)
		values.Set("my_slug", slug)
		var result brokerTasksResponse
		if err := brokerGetJSON(ctx, "/tasks?"+values.Encode(), &result); err != nil {
			continue
		}
		for _, task := range result.Tasks {
			if !taskCountsAsRunning(task) {
				continue
			}
			stamp := parseLatestTaskTime(task)
			if best.Channel != "" && !stamp.After(bestStamp) {
				continue
			}
			best = conversationContext{
				Channel:   normalizeChannelInput(task.Channel),
				ReplyToID: strings.TrimSpace(task.ThreadID),
				Source:    "owned_task",
			}
			bestStamp = stamp
		}
	}
	return best
}

func parseLatestTaskTime(task brokerTaskSummary) time.Time {
	for _, raw := range []string{strings.TrimSpace(task.UpdatedAt), strings.TrimSpace(task.CreatedAt)} {
		if raw == "" {
			continue
		}
		if stamp, err := time.Parse(time.RFC3339, raw); err == nil {
			return stamp
		}
	}
	return time.Time{}
}

func findMessageContextByID(ctx context.Context, slug, messageID string) conversationContext {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return conversationContext{}
	}
	for _, ch := range fetchAccessibleChannels(ctx, slug) {
		messages := fetchChannelMessages(ctx, ch.Slug, slug, "", 100)
		byID := make(map[string]brokerMessage, len(messages))
		for _, msg := range messages {
			if id := strings.TrimSpace(msg.ID); id != "" {
				byID[id] = msg
			}
		}
		if msg, ok := byID[messageID]; ok {
			return conversationContext{
				Channel:   ch.Slug,
				ReplyToID: threadTargetForMessage(msg, byID),
				Source:    "message_lookup",
			}
		}
	}
	return conversationContext{}
}

func findTaskContextByID(ctx context.Context, slug, taskID string) conversationContext {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return conversationContext{}
	}
	channels := fetchAccessibleChannels(ctx, slug)
	for _, ch := range channels {
		values := url.Values{}
		values.Set("channel", ch.Slug)
		if strings.TrimSpace(slug) != "" {
			values.Set("viewer_slug", strings.TrimSpace(slug))
		}
		values.Set("include_done", "true")
		var result brokerTasksResponse
		if err := brokerGetJSON(ctx, "/tasks?"+values.Encode(), &result); err != nil {
			continue
		}
		for _, task := range result.Tasks {
			if strings.TrimSpace(task.ID) == taskID {
				return conversationContext{
					Channel:   ch.Slug,
					ReplyToID: strings.TrimSpace(task.ThreadID),
					Source:    "task_lookup",
				}
			}
		}
	}
	return conversationContext{}
}

func defaultReplyTargetForChannel(ctx context.Context, slug, channel string) string {
	channel = resolveChannel(channel)
	if isOneOnOneMode() {
		return inferDirectReplyTarget(ctx, slug, channel)
	}
	if replyTo, err := inferReplyTarget(ctx, slug, channel); err == nil && strings.TrimSpace(replyTo) != "" {
		return strings.TrimSpace(replyTo)
	}
	if replyTo, err := inferDefaultThreadTarget(ctx, slug, channel); err == nil && strings.TrimSpace(replyTo) != "" {
		return strings.TrimSpace(replyTo)
	}
	return ""
}

func inferDirectReplyTarget(ctx context.Context, slug, channel string) string {
	messages := fetchChannelMessages(ctx, channel, slug, "", 40)
	if len(messages) == 0 {
		return ""
	}
	byID := make(map[string]brokerMessage, len(messages))
	for _, msg := range messages {
		if id := strings.TrimSpace(msg.ID); id != "" {
			byID[id] = msg
		}
	}
	for i := len(messages) - 1; i >= 0; i-- {
		msg := messages[i]
		if strings.TrimSpace(msg.From) == strings.TrimSpace(slug) {
			continue
		}
		return threadTargetForMessage(msg, byID)
	}
	return ""
}

func inferReplyTarget(ctx context.Context, slug string, channel string) (string, error) {
	var result brokerMessagesResponse
	if err := brokerGetJSON(ctx, "/messages?channel="+url.QueryEscape(channel)+"&my_slug="+url.QueryEscape(slug)+"&limit=25", &result); err != nil {
		return "", err
	}
	byID := make(map[string]brokerMessage, len(result.Messages))
	for _, msg := range result.Messages {
		if id := strings.TrimSpace(msg.ID); id != "" {
			byID[id] = msg
		}
	}
	for i := len(result.Messages) - 1; i >= 0; i-- {
		msg := result.Messages[i]
		if msg.From == slug {
			continue
		}
		if !contains(msg.Tagged, slug) {
			continue
		}
		if !isRecentEnough(msg.Timestamp, 15*time.Minute) {
			continue
		}
		return threadTargetForMessage(msg, byID), nil
	}
	return "", nil
}

func inferDefaultThreadTarget(ctx context.Context, slug string, channel string) (string, error) {
	var result brokerMessagesResponse
	if err := brokerGetJSON(ctx, "/messages?channel="+url.QueryEscape(channel)+"&my_slug="+url.QueryEscape(slug)+"&limit=40", &result); err != nil {
		return "", err
	}
	byID := make(map[string]brokerMessage, len(result.Messages))
	for _, msg := range result.Messages {
		if id := strings.TrimSpace(msg.ID); id != "" {
			byID[id] = msg
		}
	}
	for i := len(result.Messages) - 1; i >= 0; i-- {
		msg := result.Messages[i]
		if msg.From == slug {
			continue
		}
		if strings.HasPrefix(msg.Content, "[STATUS]") {
			continue
		}
		if !isRecentEnough(msg.Timestamp, 20*time.Minute) {
			continue
		}
		return threadTargetForMessage(msg, byID), nil
	}
	return "", nil
}

func isRecentEnough(ts string, maxAge time.Duration) bool {
	parsed, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return false
	}
	return time.Since(parsed) <= maxAge
}
