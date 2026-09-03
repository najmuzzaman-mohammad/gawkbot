package team

// broker_inbox_threads.go is Phase 3 of the unified Inbox plan. It
// reframes the Decision Inbox from "list of artifacts" into "list of
// conversations with AI bots" — one thread per bot, each thread
// carrying every InboxItem that bot has waiting on the human plus
// recent message context from the bot's DM channel.
//
// The endpoint composes on top of Phase 2:
//
//   inboxItemsForActor (Phase 2)
//       ↓ items
//   groupItemsByBot
//       ↓ per-bot buckets
//   buildThreadLocked (enrich with DM messages + member name)
//       ↓ Threads
//   GET /inbox/threads
//
// Backwards-compat with the artifact-list view stays in place: the
// existing /inbox/items endpoint continues to serve a flat list for
// callers that prefer that shape.

import (
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

// InboxThread groups every attention item from one bot under a
// single conversation surface. Phase 3 frontend renders one row per
// thread (avatar + name + preview + time) and a chat-style detail
// pane that interleaves bot messages with inline action cards for
// the pending items.
type InboxThread struct {
	Key            string      `json:"key"` // "bot:<slug>"
	BotSlug        string      `json:"agentSlug"`
	BotName        string      `json:"agentName"`
	BotRole        string      `json:"agentRole,omitempty"`
	DMChannel      string      `json:"dmChannel,omitempty"`
	LastActivityAt string      `json:"lastActivityAt"` // RFC3339
	Preview        string      `json:"preview"`        // truncated last activity
	PendingCount   int         `json:"pendingCount"`   // # of attention items
	Items          []InboxItem `json:"items"`          // attention items
}

// InboxThreadEvent is one entry in the chat-style detail stream.
// Messages and action cards interleave chronologically. The frontend
// switches on Kind to render either a message bubble or an inline
// approval card.
type InboxThreadEventKind string

const (
	InboxThreadEventMessage InboxThreadEventKind = "message"
	InboxThreadEventItem    InboxThreadEventKind = "item"
)

type InboxThreadEvent struct {
	Kind      InboxThreadEventKind `json:"kind"`
	Timestamp string               `json:"timestamp"`
	Message   *channelMessage      `json:"message,omitempty"`
	Item      *InboxItem           `json:"item,omitempty"`
}

// InboxThreadDetail is the response for GET /inbox/threads/{slug}.
// Contains the thread metadata plus the interleaved event stream
// the chat detail view consumes.
type InboxThreadDetail struct {
	Thread InboxThread        `json:"thread"`
	Events []InboxThreadEvent `json:"events"`
}

// InboxThreadsResponse is the wire shape for GET /inbox/threads.
type InboxThreadsResponse struct {
	Threads     []InboxThread `json:"threads"`
	Counts      InboxCounts   `json:"counts"`
	RefreshedAt string        `json:"refreshedAt"`
}

const threadPreviewMaxLen = 140
const threadMessageBackfillLimit = 24

// inboxThreadsForActor wraps inboxItemsForActor with per-bot
// grouping + DM message enrichment.
func (b *Broker) inboxThreadsForActor(actor requestActor) (InboxThreadsResponse, error) {
	items, err := b.inboxItemsForActor(actor, InboxFilterAll)
	if err != nil {
		return InboxThreadsResponse{}, err
	}
	byBot := map[string][]InboxItem{}
	for _, item := range items {
		slug := normalizeReviewerSlug(item.BotSlug)
		if slug == "" {
			slug = "system"
		}
		byBot[slug] = append(byBot[slug], item)
	}

	// counts come from the caller's auth-filtered items so threads
	// view never reveals task volume the caller cannot see, matching
	// the rule applied to handleInboxItems.
	counts := inboxCountsForItems(items, startOfTodayUTC())

	b.mu.Lock()
	members := append([]officeMember(nil), b.members...)
	messages := append([]channelMessage(nil), b.messages...)
	b.mu.Unlock()

	memberByCanonicalSlug := map[string]officeMember{}
	for _, m := range members {
		memberByCanonicalSlug[normalizeReviewerSlug(m.Slug)] = m
	}

	threads := make([]InboxThread, 0, len(byBot))
	for slug, bucket := range byBot {
		thread := buildInboxThread(slug, bucket, memberByCanonicalSlug, messages)
		threads = append(threads, thread)
	}

	sort.SliceStable(threads, func(i, j int) bool {
		ti := parseBrokerTimestamp(threads[i].LastActivityAt)
		tj := parseBrokerTimestamp(threads[j].LastActivityAt)
		switch {
		case ti.IsZero() && tj.IsZero():
			return strings.Compare(threads[i].BotSlug, threads[j].BotSlug) < 0
		case ti.IsZero():
			return false
		case tj.IsZero():
			return true
		default:
			return ti.After(tj)
		}
	})

	return InboxThreadsResponse{
		Threads:     threads,
		Counts:      counts,
		RefreshedAt: time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// inboxThreadDetailForActor returns one thread with its interleaved
// event stream (messages + action cards in chronological order). The
// frontend calls this when a thread row is opened.
func (b *Broker) inboxThreadDetailForActor(actor requestActor, botSlug string) (InboxThreadDetail, error) {
	slug := normalizeReviewerSlug(botSlug)
	if slug == "" {
		return InboxThreadDetail{}, errors.New("inbox: thread botSlug required")
	}
	items, err := b.inboxItemsForActor(actor, InboxFilterAll)
	if err != nil {
		return InboxThreadDetail{}, err
	}
	bucket := make([]InboxItem, 0, len(items))
	for _, item := range items {
		if normalizeReviewerSlug(item.BotSlug) == slug {
			bucket = append(bucket, item)
		}
	}

	b.mu.Lock()
	members := append([]officeMember(nil), b.members...)
	messages := append([]channelMessage(nil), b.messages...)
	b.mu.Unlock()

	memberByCanonicalSlug := map[string]officeMember{}
	for _, m := range members {
		memberByCanonicalSlug[normalizeReviewerSlug(m.Slug)] = m
	}

	thread := buildInboxThread(slug, bucket, memberByCanonicalSlug, messages)

	// Pull recent messages from the bot's DM channel + any channel
	// messages where the bot is the sender. Interleave with items.
	dmChannel := thread.DMChannel
	relevantMessages := make([]channelMessage, 0, threadMessageBackfillLimit)
	for i := len(messages) - 1; i >= 0 && len(relevantMessages) < threadMessageBackfillLimit; i-- {
		m := messages[i]
		fromMatches := normalizeReviewerSlug(m.From) == slug
		dmMatches := dmChannel != "" && normalizeChannelSlug(m.Channel) == normalizeChannelSlug(dmChannel)
		if fromMatches || dmMatches {
			relevantMessages = append(relevantMessages, m)
		}
	}
	// Reverse to chronological order.
	for i, j := 0, len(relevantMessages)-1; i < j; i, j = i+1, j-1 {
		relevantMessages[i], relevantMessages[j] = relevantMessages[j], relevantMessages[i]
	}

	events := make([]InboxThreadEvent, 0, len(relevantMessages)+len(bucket))
	for i := range relevantMessages {
		msg := relevantMessages[i]
		events = append(events, InboxThreadEvent{
			Kind:      InboxThreadEventMessage,
			Timestamp: msg.Timestamp,
			Message:   &msg,
		})
	}
	for i := range bucket {
		item := bucket[i]
		events = append(events, InboxThreadEvent{
			Kind:      InboxThreadEventItem,
			Timestamp: item.CreatedAt,
			Item:      &item,
		})
	}
	sort.SliceStable(events, func(i, j int) bool {
		ti := parseBrokerTimestamp(events[i].Timestamp)
		tj := parseBrokerTimestamp(events[j].Timestamp)
		return ti.Before(tj)
	})

	return InboxThreadDetail{
		Thread: thread,
		Events: events,
	}, nil
}

// buildInboxThread assembles a thread row from one bot's items
// plus their most recent DM/channel activity for the preview line.
func buildInboxThread(slug string, items []InboxItem, memberBySlug map[string]officeMember, messages []channelMessage) InboxThread {
	member := memberBySlug[slug]
	name := strings.TrimSpace(member.Name)
	if name == "" {
		// Fallback when the bot isn't in the office roster (legacy
		// task created by a removed member).
		name = slug
	}
	thread := InboxThread{
		Key:          "agent:" + slug,
		BotSlug:      slug,
		BotName:      name,
		BotRole:      strings.TrimSpace(member.Role),
		PendingCount: len(items),
		Items:        items,
	}
	if slug != "system" {
		thread.DMChannel = DMSlugFor(slug)
	}

	// Last activity = newest of (item.CreatedAt, latest message from
	// this bot). The preview prefers a message snippet, falling back
	// to the newest item's title.
	var lastTS time.Time
	var preview string
	for _, item := range items {
		ts := parseBrokerTimestamp(item.CreatedAt)
		if ts.After(lastTS) {
			lastTS = ts
			preview = item.Title
		}
	}
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if normalizeReviewerSlug(m.From) != slug {
			continue
		}
		ts := parseBrokerTimestamp(m.Timestamp)
		if ts.After(lastTS) {
			lastTS = ts
			preview = m.Content
		}
		break
	}
	if !lastTS.IsZero() {
		thread.LastActivityAt = lastTS.UTC().Format(time.RFC3339)
	}
	thread.Preview = truncatePreview(preview)
	return thread
}

// truncatePreview clips a preview string to threadPreviewMaxLen,
// collapsing newlines so the row layout stays single-line.
func truncatePreview(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) <= threadPreviewMaxLen {
		return s
	}
	runes := []rune(s)
	return string(runes[:threadPreviewMaxLen]) + "…"
}

// handleInboxThreads serves GET /inbox/threads.
func (b *Broker) handleInboxThreads(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	actor, ok := requestActorFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	payload, err := b.inboxThreadsForActor(actor)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// handleInboxThreadDetail serves GET /inbox/threads/{botSlug}.
func (b *Broker) handleInboxThreadDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	actor, ok := requestActorFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := strings.TrimPrefix(r.URL.Path, "/inbox/threads/")
	slug = strings.TrimSpace(slug)
	if slug == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bot slug required"})
		return
	}
	detail, err := b.inboxThreadDetailForActor(actor, slug)
	if err != nil {
		// inboxThreadDetailForActor returns one validation error
		// ("thread botSlug required", maps to 400) and otherwise
		// surfaces broker / persistence errors that should land as 500.
		if strings.Contains(err.Error(), "botSlug required") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		log.Printf("broker: inbox thread detail slug=%q: %v", slug, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "thread detail failed"})
		return
	}
	writeJSON(w, http.StatusOK, detail)
}
