package team

import (
	"fmt"
	"strings"
	"time"
)

func (b *Broker) appendActionWithRefsLocked(kind, source, channel, actor, summary, relatedID string, signalIDs []string, decisionID string) {
	b.appendActionWithMetadataLocked(kind, source, channel, actor, summary, relatedID, signalIDs, decisionID, nil)
}

// appendActionWithMetadataLocked writes one row to the office activity ledger.
//
// The Channel field records where the action happened and is deliberately left
// EMPTY when the caller did not name a channel. It used to run every value
// through normalizeChannelSlug, which turns "" into "general" — and since a
// large share of the tree calls appendActionLocked with no channel, that one
// line stamped the retired room onto a big fraction of the activity log. The
// rows then read as "this happened in #general", which is both false and
// unfilterable once the room is gone.
//
// An action with no channel is a real thing (it happened at office scope, not
// in a conversation) and the readers already handle an empty value. Recording
// the truth is better than recording a room.
func (b *Broker) appendActionWithMetadataLocked(kind, source, channel, actor, summary, relatedID string, signalIDs []string, decisionID string, metadata map[string]string) {
	actionChannel := ""
	if raw := strings.TrimSpace(channel); raw != "" {
		actionChannel = normalizeChannelSlug(raw)
	}
	record := officeActionLog{
		ID:         fmt.Sprintf("action-%d", len(b.actions)+1),
		Kind:       strings.TrimSpace(kind),
		Source:     strings.TrimSpace(source),
		Channel:    actionChannel,
		Actor:      strings.TrimSpace(actor),
		Summary:    strings.TrimSpace(summary),
		RelatedID:  strings.TrimSpace(relatedID),
		SignalIDs:  append([]string(nil), signalIDs...),
		DecisionID: strings.TrimSpace(decisionID),
		Metadata:   sanitizeActionMetadata(metadata),
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	b.actions = append(b.actions, record)
	if len(b.actions) > 150 {
		b.actions = append([]officeActionLog(nil), b.actions[len(b.actions)-150:]...)
	}
	b.publishActionLocked(record)
}

func officeSignalDedupeKey(signal officeSignal) string {
	channel := normalizeChannelSlug(signal.Channel)
	if channel == "" {
		channel = "general"
	}
	if strings.TrimSpace(signal.ID) != "" {
		return strings.Join([]string{
			strings.TrimSpace(signal.Source),
			strings.TrimSpace(signal.ID),
		}, "::")
	}
	return strings.Join([]string{
		strings.TrimSpace(signal.Source),
		channel,
		strings.TrimSpace(signal.Kind),
		truncateSummary(strings.ToLower(strings.TrimSpace(signal.Content)), 140),
	}, "::")
}

func compactStringList(items []string) []string {
	var out []string
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		out = append(out, item)
	}
	return out
}

func (b *Broker) findSignalLocked(source, sourceRef, dedupeKey string) *officeSignalRecord {
	for i := range b.signals {
		sig := &b.signals[i]
		switch {
		case source != "" && sourceRef != "" && sig.Source == source && sig.SourceRef == sourceRef:
			return sig
		case dedupeKey != "" && sig.DedupeKey == dedupeKey:
			return sig
		}
	}
	return nil
}

func (b *Broker) RecordSignals(signals []officeSignal) ([]officeSignalRecord, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	out := make([]officeSignalRecord, 0, len(signals))
	for _, signal := range signals {
		channel := normalizeChannelSlug(signal.Channel)
		if channel == "" {
			channel = "general"
		}
		dedupeKey := officeSignalDedupeKey(signal)
		if existing := b.findSignalLocked(strings.TrimSpace(signal.Source), strings.TrimSpace(signal.ID), dedupeKey); existing != nil {
			continue
		}
		record := officeSignalRecord{
			ID:            fmt.Sprintf("signal-%d", len(b.signals)+1),
			Source:        strings.TrimSpace(signal.Source),
			SourceRef:     strings.TrimSpace(signal.ID),
			Kind:          strings.TrimSpace(signal.Kind),
			Title:         strings.TrimSpace(signal.Title),
			Content:       strings.TrimSpace(signal.Content),
			Channel:       channel,
			Owner:         strings.TrimSpace(signal.Owner),
			Confidence:    strings.TrimSpace(signal.Confidence),
			Urgency:       strings.TrimSpace(signal.Urgency),
			DedupeKey:     dedupeKey,
			RequiresHuman: signal.RequiresHuman,
			Blocking:      signal.Blocking,
			CreatedAt:     time.Now().UTC().Format(time.RFC3339),
		}
		b.signals = append(b.signals, record)
		out = append(out, record)
	}
	if len(b.signals) > 200 {
		b.signals = append([]officeSignalRecord(nil), b.signals[len(b.signals)-200:]...)
	}
	if err := b.saveLocked(); err != nil {
		return nil, err
	}
	return out, nil
}

func (b *Broker) RecordDecision(kind, channel, summary, reason, owner string, signalIDs []string, requiresHuman, blocking bool) (officeDecisionRecord, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	channel = normalizeChannelSlug(channel)
	if channel == "" {
		channel = "general"
	}
	record := officeDecisionRecord{
		ID:            fmt.Sprintf("decision-%d", len(b.decisions)+1),
		Kind:          strings.TrimSpace(kind),
		Channel:       channel,
		Summary:       strings.TrimSpace(summary),
		Reason:        strings.TrimSpace(reason),
		Owner:         strings.TrimSpace(owner),
		SignalIDs:     append([]string(nil), signalIDs...),
		RequiresHuman: requiresHuman,
		Blocking:      blocking,
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	b.decisions = append(b.decisions, record)
	if len(b.decisions) > 120 {
		b.decisions = append([]officeDecisionRecord(nil), b.decisions[len(b.decisions)-120:]...)
	}
	if err := b.saveLocked(); err != nil {
		return officeDecisionRecord{}, err
	}
	return record, nil
}

func (b *Broker) RecordAction(kind, source, channel, actor, summary, relatedID string, signalIDs []string, decisionID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.appendActionWithRefsLocked(kind, source, channel, actor, summary, relatedID, signalIDs, decisionID)
	return b.saveLocked()
}

func (b *Broker) RecordActionWithMetadata(kind, source, channel, actor, summary, relatedID string, signalIDs []string, decisionID string, metadata map[string]string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.appendActionWithMetadataLocked(kind, source, channel, actor, summary, relatedID, signalIDs, decisionID, metadata)
	return b.saveLocked()
}

func (b *Broker) CreateWatchdogAlert(kind, channel, targetType, targetID, owner, summary string) (watchdogAlert, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	channel = normalizeChannelSlug(channel)
	if channel == "" {
		channel = "general"
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for i := range b.watchdogs {
		alert := &b.watchdogs[i]
		if alert.Kind == strings.TrimSpace(kind) && alert.Channel == channel && alert.TargetType == strings.TrimSpace(targetType) && alert.TargetID == strings.TrimSpace(targetID) && strings.TrimSpace(alert.Status) != "resolved" {
			alert.Owner = strings.TrimSpace(owner)
			alert.Summary = strings.TrimSpace(summary)
			alert.UpdatedAt = now
			if err := b.saveLocked(); err != nil {
				return watchdogAlert{}, false, err
			}
			return *alert, true, nil
		}
	}

	record := watchdogAlert{
		ID:         fmt.Sprintf("watchdog-%d", len(b.watchdogs)+1),
		Kind:       strings.TrimSpace(kind),
		Channel:    channel,
		TargetType: strings.TrimSpace(targetType),
		TargetID:   strings.TrimSpace(targetID),
		Owner:      strings.TrimSpace(owner),
		Status:     "active",
		Summary:    strings.TrimSpace(summary),
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	b.watchdogs = append(b.watchdogs, record)
	if len(b.watchdogs) > 120 {
		b.watchdogs = append([]watchdogAlert(nil), b.watchdogs[len(b.watchdogs)-120:]...)
	}
	// Mirror the alert into the bot's activity snapshot so the office rail
	// shows the stuck escalation immediately (no need to wait for the 90s
	// stale-while-active reaper). Owner is the bot slug for task/request
	// alerts. Best-effort: an alert without a known bot owner (e.g. stuck
	// on a system target) just doesn't surface a pill change.
	b.markBotStuckFromWatchdogLocked(record)
	if err := b.saveLocked(); err != nil {
		return watchdogAlert{}, false, err
	}
	return record, false, nil
}

// markBotStuckFromWatchdogLocked stamps the alert's Owner activity snapshot
// with Kind="stuck" and republishes it. Caller must hold b.mu. No-op when the
// owner is empty or has no live activity entry yet.
func (b *Broker) markBotStuckFromWatchdogLocked(alert watchdogAlert) {
	// Emptiness is tested on the raw value: normalizeChannelSlug
	// would have returned "general" for an ownerless alert, defeating the
	// no-op the doc comment above promises and stamping a phantom bot.
	if strings.TrimSpace(alert.Owner) == "" {
		return
	}
	slug := normalizeChannelSlug(alert.Owner)
	snap, ok := b.activity[slug]
	if !ok {
		// No prior activity for this bot — synthesize a minimal snapshot
		// so the rail still surfaces the stuck signal. Status stays empty
		// (would otherwise lie about bot state); the frontend keys off
		// Kind=="stuck" for the chrome.
		snap = botActivitySnapshot{Slug: slug}
	}
	if snap.Kind == "stuck" {
		return
	}
	snap.Kind = "stuck"
	if alert.Summary != "" {
		snap.Detail = alert.Summary
	}
	snap.LastTime = time.Now().UTC().Format(time.RFC3339)
	b.activity[slug] = snap
	b.publishActivityLocked(snap)
}

// markBotStuckClearedFromWatchdogLocked is the inverse hook for the clear
// path in resolveWatchdogAlertsLocked. It does NOT invent a new "clear" Kind:
// the alert resolution is itself treated as a routine status update so the
// pill drops the bordered chrome and waits for the next real activity event
// to repopulate live state. Caller must hold b.mu.
func (b *Broker) markBotStuckClearedFromWatchdogLocked(alert watchdogAlert) {
	// Same actor-slug + raw-emptiness pairing as markBotStuckFromWatchdogLocked
	// above; the two must agree because they key the same b.activity map.
	if strings.TrimSpace(alert.Owner) == "" {
		return
	}
	slug := normalizeChannelSlug(alert.Owner)
	snap, ok := b.activity[slug]
	if !ok {
		return
	}
	if snap.Kind != "stuck" {
		return
	}
	// If another active watchdog still claims this owner, leave the pill
	// stuck. The just-resolved alert is already marked "resolved" in
	// b.watchdogs by resolveWatchdogAlertsLocked, so the scan will skip it
	// and only catch genuinely active siblings. b.watchdogs is bounded so
	// the linear scan cost is negligible.
	for _, w := range b.watchdogs {
		if strings.TrimSpace(w.Status) == "resolved" {
			continue
		}
		// Actor normaliser, matching how `slug` was produced by the caller.
		// Both ends of this comparison must use the same one or the match
		// silently never fires for any slug the two normalisers disagree on.
		if normalizeChannelSlug(w.Owner) == slug {
			return
		}
	}
	snap.Kind = "routine"
	snap.LastTime = time.Now().UTC().Format(time.RFC3339)
	b.activity[slug] = snap
	b.publishActivityLocked(snap)
}

func (b *Broker) resolveWatchdogAlertsLocked(targetType, targetID, channel string) {
	// An empty channel means NO FILTER — resolve matching alerts in every
	// channel, the same way empty targetType and targetID are treated below.
	// Normalising first would make it "general" (normalizeChannelSlug's lobby
	// fallback) and silently narrow the sweep to one room.
	if raw := strings.TrimSpace(channel); raw != "" {
		channel = normalizeChannelSlug(raw)
	} else {
		channel = ""
	}
	for i := range b.watchdogs {
		alert := &b.watchdogs[i]
		if targetType != "" && alert.TargetType != strings.TrimSpace(targetType) {
			continue
		}
		if targetID != "" && alert.TargetID != strings.TrimSpace(targetID) {
			continue
		}
		if channel != "" && alert.Channel != "" && alert.Channel != channel {
			continue
		}
		if strings.TrimSpace(alert.Status) == "resolved" {
			continue
		}
		alert.Status = "resolved"
		alert.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		// Drop the stuck flag from the bot's activity snapshot so the
		// rail pill stops escalating. We do not try to repaint live
		// status here — the next real event from the bot owns that.
		b.markBotStuckClearedFromWatchdogLocked(*alert)
	}
}
