package team

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/bot"
)

const botIssueMessageKind = "agent_issue"

// systemAuthErrorMessageKind is the message kind emitted when the bot
// loop hits a provider auth failure (e.g. "Not logged in - Please run
// /login"). The SPA renders these as a SystemErrorCard banner (system
// authored, distinct visual treatment) instead of a bot-authored
// chat bubble. Issue #933.
const systemAuthErrorMessageKind = "system_auth_error"

var incidentWhitespacePattern = regexp.MustCompile(`\s+`)

type incidentClassification struct {
	Visible       bool
	CapabilityGap bool
	HumanAction   bool
	Severity      string
}

func (b *Broker) ReportIncident(botSlug, targetChannel, replyTo, detail string) (channelMessage, incidentRecord, bool, error) {
	if b == nil {
		return channelMessage{}, incidentRecord{}, false, nil
	}
	detail = strings.TrimSpace(detail)
	if detail == "" {
		return channelMessage{}, incidentRecord{}, false, nil
	}
	classification := classifyIncident(detail)
	if !classification.Visible {
		return channelMessage{}, incidentRecord{}, false, nil
	}
	safeDetail := detail

	// Issue #933: provider auth failures (e.g. claude returning "Not logged
	// in - Please run /login") would otherwise post as bot-authored chat
	// bubbles — visually indistinguishable from in-character bot output
	// and confusing because the bot isn't speaking. Detect the auth
	// signal and route through a dedicated system-authored card that
	// carries a structured payload the SPA renders as a SystemErrorCard.
	if authProbe := classifyProviderAuthError(safeDetail); authProbe.IsAuthError {
		return b.postSystemAuthErrorIncident(botSlug, targetChannel, replyTo, safeDetail, authProbe)
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	botSlug = strings.TrimSpace(botSlug)
	if botSlug == "" {
		botSlug = "agent"
	}
	// An incident with no named channel belongs in the reporting bot's own
	// DM. It used to land in "general", so once the shared room was retired
	// every channel-less incident — including the provider-auth banner the
	// human has to act on — failed the lookup below with "channel not found"
	// and was lost entirely.
	channel := normalizeChannelSlug(targetChannel)
	if strings.TrimSpace(targetChannel) == "" {
		// homeChannelForLocked, not DMSlugFor: it verifies the reporter is
		// actually on the roster before minting a DM. botSlug defaults to
		// the placeholder "bot" just above, and DMSlugFor would happily
		// build "agent__human" and create a conversation for a member that
		// does not exist. On failure the channel stays empty and the lookup
		// below reports "channel not found", which is the honest outcome.
		if home, err := b.homeChannelForLocked(botSlug); err == nil {
			channel = home
		}
	}
	if b.findChannelLocked(channel) == nil {
		if IsDMSlug(channel) {
			if dm := b.ensureDMConversationLocked(channel); dm != nil {
				channel = dm.Slug
			}
		}
		if b.findChannelLocked(channel) == nil {
			return channelMessage{}, incidentRecord{}, false, fmt.Errorf("channel not found")
		}
	}
	if !b.canAccessChannelLocked(botSlug, channel) {
		return channelMessage{}, incidentRecord{}, false, fmt.Errorf("channel access denied")
	}

	taskID := b.activeTaskIDForBotLocked(botSlug)
	key := normalizedIncidentKey(botSlug, channel, safeDetail)
	now := time.Now().UTC().Format(time.RFC3339)
	for i := range b.incidents {
		inc := &b.incidents[i]
		if inc.Bot != botSlug || inc.Channel != channel || inc.NormalizedKey != key {
			continue
		}
		inc.Count++
		inc.UpdatedAt = now
		if inc.TaskID == "" {
			inc.TaskID = taskID
		}
		if classification.CapabilityGap && !classification.HumanAction {
			b.ensureSelfHealApprovalRequestLocked(inc, classification, safeDetail)
		}
		if err := b.saveLocked(); err != nil {
			return channelMessage{}, *inc, false, err
		}
		return channelMessage{}, *inc, false, nil
	}

	b.counter++
	incidentID := fmt.Sprintf("incident-%d", b.counter)
	inc := incidentRecord{
		ID:            incidentID,
		Bot:           botSlug,
		Channel:       channel,
		ReplyTo:       strings.TrimSpace(replyTo),
		Detail:        safeDetail,
		NormalizedKey: key,
		Severity:      classification.Severity,
		TaskID:        taskID,
		Count:         1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	b.counter++
	msg := channelMessage{
		ID:        fmt.Sprintf("msg-%d", b.counter),
		From:      botSlug,
		Channel:   channel,
		Kind:      botIssueMessageKind,
		EventID:   inc.ID,
		Content:   "Incident: " + truncate(safeDetail, 600),
		ReplyTo:   strings.TrimSpace(replyTo),
		Timestamp: now,
	}
	b.incidents = append(b.incidents, inc)
	incPtr := &b.incidents[len(b.incidents)-1]
	msg = b.appendMessageLocked(msg)
	b.appendActionLocked("agent_issue", "office", channel, botSlug, truncateSummary(msg.Content, 140), inc.ID)
	if classification.CapabilityGap && !classification.HumanAction {
		b.ensureSelfHealApprovalRequestLocked(incPtr, classification, safeDetail)
	}
	if err := b.saveLocked(); err != nil {
		return channelMessage{}, *incPtr, false, err
	}
	return msg, *incPtr, true, nil
}

func (b *Broker) Incidents() []incidentRecord {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]incidentRecord, len(b.incidents))
	for i, inc := range b.incidents {
		out[i] = sanitizeIncidentRecord(inc)
	}
	return out
}

func sanitizeIncidentRecord(inc incidentRecord) incidentRecord {
	inc.NormalizedKey = normalizedIncidentKey(inc.Bot, inc.Channel, inc.Detail)
	return inc
}

func (b *Broker) pruneIncidentsByChannelLocked(channelSlug string) {
	b.pruneIncidentsByChannelAndBotLocked(channelSlug, "")
}

func (b *Broker) pruneIncidentsByChannelAndBotLocked(channelSlug, botSlug string) {
	// Raw emptiness before normalising: an empty channel became "general", so
	// this refusal never fired and an incident sweep with no channel swept the
	// shared room instead of declining.
	if strings.TrimSpace(channelSlug) == "" || len(b.incidents) == 0 {
		return
	}
	channelSlug = normalizeChannelSlug(channelSlug)
	botSlug = strings.TrimSpace(botSlug)
	removedRequestIDs := make(map[string]struct{})
	filtered := b.incidents[:0]
	for _, inc := range b.incidents {
		if normalizeChannelSlug(inc.Channel) != channelSlug || (botSlug != "" && strings.TrimSpace(inc.Bot) != botSlug) {
			filtered = append(filtered, inc)
			continue
		}
		if reqID := strings.TrimSpace(inc.ApprovalRequestID); reqID != "" {
			removedRequestIDs[reqID] = struct{}{}
		}
	}
	b.incidents = filtered
	if len(removedRequestIDs) == 0 {
		return
	}
	requests := b.requests[:0]
	for _, req := range b.requests {
		if _, remove := removedRequestIDs[strings.TrimSpace(req.ID)]; !remove {
			requests = append(requests, req)
		}
	}
	b.requests = requests
	b.pendingInterview = firstBlockingRequest(b.requests)
}

// providerAuthErrorProbe captures the classification + suggested remediation
// for a detected provider auth failure. Used by ReportIncident to fork
// into the SystemErrorCard rendering path (issue #933).
type providerAuthErrorProbe struct {
	IsAuthError   bool
	Provider      string
	SignInCommand string
}

// classifyProviderAuthError matches detail strings that signal a runtime
// provider's auth/login surface is the proximate cause (e.g. the Claude
// CLI's "Not logged in - Please run /login"). Returns Provider="" when
// the auth signal is detected but the runtime is ambiguous; the SPA
// renders a generic "Sign in" CTA in that case.
//
// Substring matching is intentional — the upstream messages differ across
// providers and across versions. Mirrors the test surface in
// internal/provider/claude.go::isClaudeLoginRequired.
func classifyProviderAuthError(detail string) providerAuthErrorProbe {
	text := strings.ToLower(strings.TrimSpace(detail))
	if text == "" {
		return providerAuthErrorProbe{}
	}
	// Auth signal set. Keep this list in sync with isClaudeLoginRequired
	// in internal/provider/claude.go and the equivalent check in codex.go.
	authSignals := []string{
		"not logged in",
		"please log in",
		"please run `claude login`",
		"please run claude login",
		"please run `codex login`",
		"please run codex login",
		"please run /login",
		"login required",
		"requires login",
		"authentication required",
		"unauthorized",
		"requires login. run",
	}
	matched := false
	for _, signal := range authSignals {
		if strings.Contains(text, signal) {
			matched = true
			break
		}
	}
	if !matched {
		return providerAuthErrorProbe{}
	}

	probe := providerAuthErrorProbe{IsAuthError: true}
	// Identify the provider from the surrounding text so the SPA can
	// surface a runtime-specific sign-in CTA. The detection here mirrors
	// the patterns describeClaude/Codex/Opencode emit through provider
	// error paths.
	switch {
	case strings.Contains(text, "claude"):
		probe.Provider = "claude-code"
		probe.SignInCommand = "claude auth login"
	case strings.Contains(text, "codex"):
		probe.Provider = "codex"
		probe.SignInCommand = "codex login"
	case strings.Contains(text, "opencode"):
		probe.Provider = "opencode"
		probe.SignInCommand = "opencode auth login"
	}
	return probe
}

// postSystemAuthError emits a system-authored message with kind
// systemAuthErrorMessageKind into the target channel. Payload carries the
// provider name + suggested sign-in command so the SPA's SystemErrorCard
// can render a copy-to-clipboard CTA. Returns (msg, _, posted=true, nil)
// on success so the call site doesn't have to special-case dispatch.
//
// Idempotency: collapses repeated auth errors from the same provider+
// channel within a short window. The chat doesn't need three identical
// banners in a row.
func (b *Broker) postSystemAuthErrorIncident(botSlug, targetChannel, replyTo, safeDetail string, probe providerAuthErrorProbe) (channelMessage, incidentRecord, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	botSlug = strings.TrimSpace(botSlug)
	if botSlug == "" {
		botSlug = "agent"
	}

	// An incident with no named channel belongs in the reporting bot's own
	// DM. It used to land in "general", so once the shared room was retired
	// every channel-less incident — including the provider-auth banner the
	// human has to act on — failed the lookup below with "channel not found"
	// and was lost entirely.
	channel := normalizeChannelSlug(targetChannel)
	if strings.TrimSpace(targetChannel) == "" {
		// homeChannelForLocked, not DMSlugFor: it verifies the reporter is
		// actually on the roster before minting a DM. botSlug defaults to
		// the placeholder "bot" just above, and DMSlugFor would happily
		// build "agent__human" and create a conversation for a member that
		// does not exist. On failure the channel stays empty and the lookup
		// below reports "channel not found", which is the honest outcome.
		if home, err := b.homeChannelForLocked(botSlug); err == nil {
			channel = home
		}
	}
	if b.findChannelLocked(channel) == nil {
		if IsDMSlug(channel) {
			if dm := b.ensureDMConversationLocked(channel); dm != nil {
				channel = dm.Slug
			}
		}
		if b.findChannelLocked(channel) == nil {
			return channelMessage{}, incidentRecord{}, false, fmt.Errorf("channel not found")
		}
	}
	// Channel ACL gate, mirroring ReportIncident. Without this, a bot
	// could surface a system-auth banner into a channel it has no business
	// in (e.g. another bot's DM) just because the LLM happened to fail
	// while resolving it.
	if !b.canAccessChannelLocked(botSlug, channel) {
		return channelMessage{}, incidentRecord{}, false, fmt.Errorf("channel access denied")
	}

	// Dedup: if the most recent message in the channel is already a
	// system_auth_error for the same provider, suppress the repeat. The
	// SPA's existing banner is still up; emitting a duplicate would just
	// stack identical cards.
	if probe.Provider != "" {
		for i := len(b.messages) - 1; i >= 0; i-- {
			m := b.messages[i]
			if m.Channel != channel {
				continue
			}
			if m.Kind != systemAuthErrorMessageKind {
				break
			}
			// Last message in channel IS a system_auth_error — check provider.
			if strings.Contains(string(m.Payload), `"provider":"`+probe.Provider+`"`) {
				return m, incidentRecord{}, false, nil
			}
			break
		}
	}

	payloadMap := map[string]string{
		"provider":        probe.Provider,
		"sign_in_command": probe.SignInCommand,
		"detail":          truncate(safeDetail, 600),
		"reporter":        strings.TrimSpace(botSlug),
	}
	payloadBytes, err := json.Marshal(payloadMap)
	if err != nil {
		// json.Marshal of a map[string]string never fails in practice,
		// but if it ever did we'd rather post a degraded banner than
		// drop the auth signal entirely.
		payloadBytes = []byte("{}")
	}

	now := time.Now().UTC().Format(time.RFC3339)
	displayContent := "Sign in required"
	if probe.Provider != "" {
		displayContent = "Sign in required for " + probe.Provider
	}

	b.counter++
	msg := channelMessage{
		ID:        fmt.Sprintf("msg-%d", b.counter),
		From:      "system",
		Channel:   channel,
		Kind:      systemAuthErrorMessageKind,
		Content:   displayContent,
		Payload:   payloadBytes,
		ReplyTo:   strings.TrimSpace(replyTo),
		Timestamp: now,
	}
	msg = b.appendMessageLocked(msg)
	if err := b.saveLocked(); err != nil {
		return channelMessage{}, incidentRecord{}, false, err
	}
	return msg, incidentRecord{}, true, nil
}

func classifyIncident(detail string) incidentClassification {
	trimmed := strings.TrimSpace(detail)
	if trimmed == "" {
		return incidentClassification{}
	}
	if looksStructuredIncidentPayload(trimmed) {
		return incidentClassification{}
	}
	text := strings.ToLower(trimmed)
	visibleSignals := []string{
		"error", "failed", "failure", "unavailable", "not available", "not configured",
		"not connected", "missing", "denied", "forbidden", "unauthorized", "requires",
		"cannot", "can't", "unable", "unsupported", "timed out", "timeout",
	}
	visible := false
	for _, signal := range visibleSignals {
		if strings.Contains(text, signal) {
			visible = true
			break
		}
	}
	if !visible {
		return incidentClassification{}
	}
	humanAction := strings.Contains(text, "login") ||
		strings.Contains(text, "sign in") ||
		strings.Contains(text, "authenticate") ||
		strings.Contains(text, "oauth") ||
		strings.Contains(text, "two-factor") ||
		strings.Contains(text, "2fa")
	return incidentClassification{
		Visible:       true,
		CapabilityGap: isCapabilityGapBlocker(detail),
		HumanAction:   humanAction,
		Severity:      "warning",
	}
}

func looksStructuredIncidentPayload(text string) bool {
	if text == "" {
		return false
	}
	if (strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[")) && json.Valid([]byte(text)) {
		return true
	}
	return strings.Contains(text, `":`) && json.Valid([]byte(text))
}

func normalizedIncidentKey(botSlug, channel, detail string) string {
	text := strings.ToLower(strings.TrimSpace(detail))
	for _, prefix := range []string{"incident:", "issue:", "error:", "failed:", "failure:"} {
		text = strings.TrimSpace(strings.TrimPrefix(text, prefix))
	}
	text = incidentWhitespacePattern.ReplaceAllString(text, " ")
	if len(text) > 180 {
		text = text[:180]
	}
	return strings.Join([]string{strings.TrimSpace(botSlug), normalizeChannelSlug(channel), text}, "|")
}

func (b *Broker) activeTaskIDForBotLocked(botSlug string) string {
	botSlug = strings.TrimSpace(botSlug)
	if botSlug == "" {
		return ""
	}
	for i := range b.tasks {
		task := &b.tasks[i]
		if strings.TrimSpace(task.Owner) != botSlug {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(task.status), "in_progress") {
			return task.ID
		}
	}
	return ""
}

func (b *Broker) ensureSelfHealApprovalRequestLocked(issue *incidentRecord, classification incidentClassification, detail string) {
	if b == nil || issue == nil || issue.SelfHealTaskID != "" {
		return
	}
	if req := b.findRequestByIDLocked(issue.ApprovalRequestID); req != nil {
		if requestIsActive(*req) {
			return
		}
		if req.Answered != nil {
			if selfHealApprovalGranted(req.Answered.ChoiceID) {
				b.maybeCreateApprovedSelfHealTaskLocked(*req)
			}
			return
		}
	}

	b.counter++
	now := time.Now().UTC().Format(time.RFC3339)
	req := humanInterview{
		ID:       fmt.Sprintf("request-%d", b.counter),
		Kind:     "approval",
		Status:   "pending",
		From:     "system",
		Channel:  issue.Channel,
		Title:    "Approve self-heal",
		Question: fmt.Sprintf("I recommend creating a self-heal task to restore @%s's missing capability. Proceed?", issue.Bot),
		Context: strings.Join([]string{
			"Incident: " + detail,
			"Incident ID: " + issue.ID,
			"Original task: " + valueOrUnknown(issue.TaskID),
		}, "\n"),
		Options: []interviewOption{
			{ID: "approve", Label: "Proceed", Description: "Create the recommended self-heal task."},
			{ID: "approve_with_note", Label: "Proceed with note", Description: "Create the task with extra constraints.", RequiresText: true, TextHint: "Type constraints or guardrails for the repair task."},
			{ID: "reject", Label: "Dismiss", Description: "Do not create repair work for this issue."},
			{ID: "reject_with_steer", Label: "Override", Description: "Do not use the default repair path. Provide different steering.", RequiresText: true, TextHint: "Type the alternate repair path or reason to skip."},
		},
		RecommendedID: "approve",
		Blocking:      false,
		Required:      false,
		ReplyTo:       strings.TrimSpace(issue.ReplyTo),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	req.Options, req.RecommendedID = normalizeRequestOptions(req.Kind, req.RecommendedID, req.Options)
	b.scheduleRequestLifecycleLocked(&req)
	b.requests = append(b.requests, req)
	b.pendingInterview = firstBlockingRequest(b.requests)
	issue.ApprovalRequestID = req.ID
	issue.UpdatedAt = now
	b.counter++
	b.appendMessageLocked(channelMessage{
		ID:        fmt.Sprintf("msg-%d", b.counter),
		From:      "system",
		Channel:   issue.Channel,
		Kind:      "approval",
		EventID:   req.ID,
		Title:     req.Title,
		Content:   req.Question,
		Tagged:    uniqueSlugs([]string{issue.Bot}),
		ReplyTo:   strings.TrimSpace(issue.ReplyTo),
		Timestamp: now,
	})
	b.appendActionLocked("request_created", "office", issue.Channel, req.From, truncateSummary(req.Title+" "+req.Question, 140), req.ID)
}

func (b *Broker) findRequestByIDLocked(id string) *humanInterview {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	for i := range b.requests {
		if b.requests[i].ID == id {
			return &b.requests[i]
		}
	}
	return nil
}

func selfHealApprovalGranted(choiceID string) bool {
	switch strings.TrimSpace(choiceID) {
	case "approve", "approve_with_note", "confirm_proceed", "proceed":
		return true
	default:
		return false
	}
}

func (b *Broker) maybeCreateApprovedSelfHealTaskLocked(req humanInterview) {
	if !selfHealApprovalGranted(req.Answered.GetChoiceID()) {
		return
	}
	var issue *incidentRecord
	for i := range b.incidents {
		if b.incidents[i].ApprovalRequestID == req.ID {
			issue = &b.incidents[i]
			break
		}
	}
	if issue == nil || issue.SelfHealTaskID != "" {
		return
	}
	detail := issue.Detail
	if note := strings.TrimSpace(req.Answered.GetCustomText()); note != "" {
		detail = strings.TrimSpace(detail + "\n\nHuman constraints: " + note)
	}
	task, _, err := b.requestSelfHealingLocked(issue.Bot, issue.TaskID, bot.EscalationCapabilityGap, detail)
	if err != nil {
		log.Printf("incident: create approved self-heal task for incident=%s bot=%s: %v", issue.ID, issue.Bot, err)
		errText := strings.TrimSpace(err.Error())
		if errText == "" {
			errText = "unknown error"
		}
		alreadyReported := issue.SelfHealError == errText
		now := time.Now().UTC().Format(time.RFC3339)
		issue.SelfHealError = errText
		issue.UpdatedAt = now
		if !alreadyReported {
			b.notifySelfHealCreationFailureLocked(issue, errText, now)
		}
		return
	}
	// requestSelfHealingLocked may return an overflow-merge task — when the
	// bot is at the per-bot cap and this issue's failing TaskID has no
	// self-heal of its own, the incident is merged into a different
	// (bot, taskID) self-heal task. Bind to it either way so the dedupe
	// gates above fire (otherwise the human is re-prompted and the same
	// incident is re-merged on every iteration), but record the overflow in
	// SelfHealError so the divergence between issue.TaskID and the linked
	// task's TaskID is observable instead of silent.
	parentTitle := ""
	if parent := b.findTaskByIDLocked(issue.TaskID); parent != nil {
		parentTitle = strings.TrimSpace(parent.Title)
	}
	expectedTitle := selfHealingTaskTitle(issue.Bot, issue.TaskID, parentTitle, bot.EscalationCapabilityGap)
	issue.SelfHealTaskID = task.ID
	if task.Title == expectedTitle {
		issue.SelfHealError = ""
	} else {
		issue.SelfHealError = fmt.Sprintf("merged into bot self-heal overflow lane (%s)", task.ID)
	}
	issue.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
}

func (b *Broker) notifySelfHealCreationFailureLocked(issue *incidentRecord, errText, now string) {
	if b == nil || issue == nil {
		return
	}
	botSlug := strings.TrimSpace(issue.Bot)
	if botSlug == "" {
		botSlug = "agent"
	}
	channel := normalizeChannelSlug(issue.Channel)
	if channel == "" {
		channel = "general"
	}
	content := fmt.Sprintf("Incident: approved self-heal for @%s could not be created: %s", botSlug, truncate(errText, 400))
	b.counter++
	b.appendMessageLocked(channelMessage{
		ID:        fmt.Sprintf("msg-%d", b.counter),
		From:      "system",
		Channel:   channel,
		Kind:      botIssueMessageKind,
		EventID:   strings.TrimSpace(issue.ID),
		Content:   content,
		Tagged:    uniqueSlugs([]string{botSlug}),
		ReplyTo:   strings.TrimSpace(issue.ReplyTo),
		Timestamp: now,
	})
	b.appendActionLocked("agent_issue", "office", channel, "system", truncateSummary(content, 140), strings.TrimSpace(issue.ID))
}

func (a *interviewAnswer) GetChoiceID() string {
	if a == nil {
		return ""
	}
	return strings.TrimSpace(a.ChoiceID)
}

func (a *interviewAnswer) GetCustomText() string {
	if a == nil {
		return ""
	}
	return strings.TrimSpace(a.CustomText)
}

func valueOrUnknown(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	return value
}
