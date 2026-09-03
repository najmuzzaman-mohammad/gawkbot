package team

// notifier_targets.go owns notification target resolution
// (PLAN.md §C11): given a channel message or a task action, who
// should be woken (immediate vs delayed)? The biggest piece is
// notificationTargetsForMessage (200+ lines) which runs the
// CEO/specialist routing decision tree. Split out of launcher.go
// so the routing logic is reviewable separately from delivery.

import (
	"strings"
	"time"
)

// containsSlug reports whether the slug list contains want. Moved
// here from launcher.go (PLAN.md §C16) — the routing decision tree
// is the only in-package caller. teammcp/server.go has its own copy
// by the same name; the packages don't share helpers.
func containsSlug(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

type officeChangeTaskNotification struct {
	Target  notificationTarget
	Action  officeActionLog
	Task    teamTask
	Content string
}

func (l *Launcher) deliverOfficeChangeNotification(evt officeChangeEvent) {
	for _, notification := range l.officeChangeTaskNotifications(evt) {
		l.sendTaskUpdate(notification.Target, notification.Action, notification.Task, notification.Content)
	}
}

func (l *Launcher) officeChangeTaskNotifications(evt officeChangeEvent) []officeChangeTaskNotification {
	if l == nil || l.broker == nil {
		return nil
	}

	kind := strings.TrimSpace(evt.Kind)
	// evt.Slug is POLYMORPHIC: a MEMBER slug for the member_* kinds and a
	// CHANNEL slug for the channel_* kinds (office_reseeded carries none). It is
	// therefore passed through RAW and normalised at the point of use, inside
	// shouldBackfillTaskOwner, where the branch already knows which kind it
	// holds. Normalising here would mean choosing a normaliser before anyone
	// knows which kind of slug this is — which is the bug this replaced.
	slug := strings.TrimSpace(evt.Slug)
	switch kind {
	case "member_created", "channel_created", "channel_updated":
	default:
		return nil
	}
	if slug == "" {
		// No subject to match against. Bailing here matters: an empty slug
		// used to normalise to "general" and would now match every task in
		// that channel.
		return nil
	}

	targetMap := l.targeter().PaneTargets()
	if len(targetMap) == 0 {
		return nil
	}

	now := time.Now().UTC().Format(time.RFC3339)
	seen := make(map[string]struct{})
	var out []officeChangeTaskNotification
	for _, task := range l.broker.AllTasks() {
		owner := strings.TrimSpace(task.Owner)
		if owner == "" {
			continue
		}
		if !shouldBackfillTaskOwner(kind, slug, task) {
			continue
		}
		enabled := false
		for _, member := range l.broker.EnabledMembers(task.Channel) {
			if member == owner {
				enabled = true
				break
			}
		}
		if !enabled {
			continue
		}
		target, ok := targetMap[owner]
		if !ok {
			continue
		}
		key := owner + ":" + task.ID
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		action := officeActionLog{
			Kind:      "task_updated",
			Source:    "office",
			Channel:   normalizeChannelSlug(task.Channel),
			Actor:     "system",
			RelatedID: task.ID,
			CreatedAt: now,
		}
		out = append(out, officeChangeTaskNotification{
			Target:  target,
			Action:  action,
			Task:    task,
			Content: l.taskNotificationContent(action, task),
		})
	}
	return out
}

func shouldBackfillTaskOwner(kind, slug string, task teamTask) bool {
	status := strings.ToLower(strings.TrimSpace(task.status))
	if status == "done" || status == "canceled" || status == "cancelled" || status == "review" {
		return false
	}
	if task.blocked {
		return false
	}
	// `slug` arrives RAW from officeChangeTaskNotifications, because which
	// normaliser is correct depends on the kind. Each branch normalises BOTH
	// sides of its own comparison, so the choice is stated rather than
	// inherited from whatever the caller happened to apply.
	switch kind {
	case "member_created":
		// Both sides are ACTOR slugs. task.Owner is stored via a plain
		// TrimSpace with no slug normalisation (see the task mutation paths),
		// so a capitalised owner like "Designer" is genuinely storable. This
		// comparison used to put a lowercased, channel-normalised slug against
		// that raw owner, so such a task never matched and silently never got
		// its owner backfilled. Normalising both sides is the fix.
		return normalizeActorSlug(task.Owner) == normalizeActorSlug(slug)
	case "channel_created", "channel_updated":
		// Both sides are CHANNEL slugs. This half was already correct; it is
		// spelled out symmetrically so the two branches read the same way and
		// neither can drift back to normalising at the call site.
		return normalizeChannelSlug(task.Channel) == normalizeChannelSlug(slug)
	default:
		return false
	}
}

type notificationTarget struct {
	PaneTarget string
	Slug       string
}

func (l *Launcher) taskNotificationTargets(action officeActionLog, task teamTask) (immediate []notificationTarget, delayed []notificationTarget) {
	targetMap := l.targeter().NotificationTargets()
	if len(targetMap) == 0 {
		return nil, nil
	}
	lead := l.targeter().LeadSlug()
	enabledMembers := map[string]struct{}{}
	disabledMembers := map[string]struct{}{}
	if l.broker != nil {
		for _, member := range l.broker.EnabledMembers(task.Channel) {
			enabledMembers[member] = struct{}{}
		}
		for _, member := range l.broker.DisabledMembers(task.Channel) {
			disabledMembers[member] = struct{}{}
		}
	}
	// Task ownership is an explicit human/CEO assignment. The same bypass that
	// lets an @-tag wake a wizard-hired specialist applies here: the owner may
	// have been hired post-seed and not yet in ch.Members. Disabled (muted)
	// members are still excluded — muting is an explicit silence.
	actor := strings.TrimSpace(action.Actor)
	owner := strings.TrimSpace(task.Owner)
	isAssigned := func(slug string) bool {
		return slug != "" && (slug == owner || slug == actor)
	}
	addImmediate := func(slug string) {
		if slug == "" {
			return
		}
		if _, muted := disabledMembers[slug]; muted {
			return
		}
		if !isAssigned(slug) && len(enabledMembers) > 0 {
			if _, ok := enabledMembers[slug]; !ok {
				return
			}
		}
		if target, ok := targetMap[slug]; ok {
			immediate = append(immediate, target)
			delete(targetMap, slug)
		}
	}
	addDelayed := func(slug string) {
		if slug == "" {
			return
		}
		if _, muted := disabledMembers[slug]; muted {
			return
		}
		if !isAssigned(slug) && len(enabledMembers) > 0 {
			if _, ok := enabledMembers[slug]; !ok {
				return
			}
		}
		if target, ok := targetMap[slug]; ok {
			delayed = append(delayed, target)
			delete(targetMap, slug)
		}
	}

	// Post-done follow-up (done-integrity): the human posted in a delivered
	// task's channel. Wake the OWNER — they hold the context to reopen or
	// answer; the lead is not re-routed here (the message loop already woke
	// it for the channel post itself).
	if action.Kind == taskFollowUpActionKind {
		if owner != "" && owner != actor {
			addImmediate(owner)
		} else if lead != "" && lead != actor {
			addImmediate(lead)
		}
		return immediate, delayed
	}

	if owner == "" {
		if lead != "" && lead != actor {
			addImmediate(lead)
		}
		return immediate, delayed
	}

	if owner == lead {
		if lead != "" && lead != actor {
			addImmediate(lead)
		}
		return immediate, delayed
	}

	// Assigned owners should start immediately when new work lands, especially
	// for CEO-created or automation-created tasks. This is the bridge between
	// "policy created work" and "the specialist actually begins moving."
	//
	// Exception: do not wake the owner when the task is blocked (unresolved
	// dependencies). They have no work to do until the blocker clears. They
	// will be notified via a task_unblocked action when deps resolve.
	if (action.Kind == "task_created" || action.Kind == "watchdog_alert" || action.Kind == "task_unblocked") && owner != actor && !task.blocked {
		addImmediate(owner)
	} else if owner != actor && action.Kind != "task_created" {
		addDelayed(owner)
	}

	if lead != "" && lead != owner && lead != actor && !(action.Kind == "task_created" && actor == lead) && shouldWakeLeadForTaskAction(action, task) {
		addImmediate(lead)
	}

	return immediate, delayed
}

func shouldWakeLeadForTaskAction(action officeActionLog, task teamTask) bool {
	// App-builder work is self-sufficient single-bot work: the builder owns the
	// whole describe -> build -> verify -> publish loop and needs no lead (CEO)
	// coordination. Waking the lead here only spawns a redundant parallel build
	// that duplicates the work, burns turns and tokens, and can trip the budget
	// gate. Keep the lead out of app-builder builds and edits entirely.
	if isAppBuilderSlug(strings.TrimSpace(task.Owner)) {
		return false
	}
	if strings.TrimSpace(action.Kind) != "task_updated" {
		return true
	}
	actor := strings.TrimSpace(action.Actor)
	owner := strings.TrimSpace(task.Owner)
	if actor == "" || owner == "" || actor != owner {
		return true
	}
	if task.blocked {
		return true
	}
	status := strings.ToLower(strings.TrimSpace(task.status))
	review := strings.ToLower(strings.TrimSpace(task.reviewState))
	if status == "review" || status == "done" || status == "blocked" {
		return true
	}
	if review == "ready_for_review" || review == "approved" {
		return true
	}
	return false
}

func (l *Launcher) shouldDeliverDelayedTaskNotification(targetSlug string, action officeActionLog, task teamTask) bool {
	if l.broker == nil {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(task.status), "done") {
		return false
	}
	current, ok := l.taskForAction(action)
	if !ok {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(current.status), "done") {
		return false
	}
	if strings.TrimSpace(current.Owner) != "" && strings.TrimSpace(current.Owner) != targetSlug && targetSlug != l.targeter().LeadSlug() {
		return false
	}
	if strings.TrimSpace(current.Owner) == "" && targetSlug != l.targeter().LeadSlug() {
		return false
	}
	return true
}

// isChannelDM returns true if the channel is a DM (either old dm-* format or new Store type).
// botTarget returns the bot slug that should receive the DM notification (non-human side).
// isChannelDM is the public entry point used by dispatch code; targeter
// reads the same logic via the isChannelDMRaw callback.
func (l *Launcher) isChannelDM(channelSlug string) (isDM bool, botTarget string) {
	return l.isChannelDMRaw(channelSlug)
}

// isChannelDMRaw resolves whether a channel is a direct-message channel
// and, if so, which bot it targets. Two formats supported: the legacy
// "dm-{bot}" slug and the new store format where channel.type == "D".
func (l *Launcher) isChannelDMRaw(channelSlug string) (isDM bool, botTarget string) {
	if IsDMSlug(channelSlug) {
		return true, DMTargetBot(channelSlug)
	}
	if l.broker != nil {
		cs := l.broker.ChannelStore()
		if cs != nil && cs.IsDirectMessageBySlug(channelSlug) {
			ch, ok := cs.GetBySlug(channelSlug)
			if ok {
				members := cs.Members(ch.ID)
				for _, m := range members {
					if !isHumanMessageSender(m.Slug) {
						return true, m.Slug
					}
				}
			}
		}
	}
	return false, ""
}

func (l *Launcher) notificationTargetsForMessage(msg channelMessage) (immediate []notificationTarget, delayed []notificationTarget) {
	targetMap := l.targeter().NotificationTargets()
	if len(targetMap) == 0 {
		return nil, nil
	}
	// DMs are isolated: only the other side gets notified, never CEO or others.
	//
	// Resolved relative to the SENDER, not to the human. The human-relative
	// lookup could not name a recipient in a bot-to-bot DM at all
	// ("ceo__designer" has no human side), so those messages reached nobody —
	// which is what blocked the consult relay. Sender-relative also makes the
	// old "don't echo a bot's own message back" guard structural: the
	// participant across from the sender is never the sender.
	if ch := normalizeChannelSlug(msg.Channel); IsDMSlug(ch) {
		recipient := DMOtherParticipant(ch, msg.From)
		if recipient == "" {
			// The sender is not a participant — a system or broker post into
			// the DM. Fall back to the human-relative bot so those still
			// wake the bot in a human<->bot DM, as they always have. In an
			// bot-to-bot DM this is "" and nobody is woken: with no viewer
			// to resolve against there is no non-arbitrary side to pick.
			recipient = DMTargetBot(ch)
		}
		if recipient == "" || isHumanMessageSender(recipient) || recipient == msg.From {
			return nil, nil
		}
		// Bot-pair DMs cap partner wakes per window so two bots cannot
		// ping-pong each other forever. The message still lands in the DM;
		// only the wake is suppressed until the window rolls over.
		if l.broker != nil && !l.broker.BotDMWakeAllowed(ch) {
			return nil, nil
		}
		if target, ok := targetMap[recipient]; ok {
			return []notificationTarget{target}, nil
		}
		return nil, nil
	}
	// Also check the new Store-based DM format.
	if ch := normalizeChannelSlug(msg.Channel); !IsDMSlug(ch) {
		if isDM, botSlug := l.isChannelDM(ch); isDM {
			if !isHumanMessageSender(msg.From) && botSlug == msg.From {
				return nil, nil
			}
			if target, ok := targetMap[botSlug]; ok {
				return []notificationTarget{target}, nil
			}
			return nil, nil
		}
	}
	if l.isOneOnOne() {
		slug := l.oneOnOneBot()
		if slug == "" || slug == msg.From {
			return nil, nil
		}
		target, ok := targetMap[slug]
		if !ok {
			return nil, nil
		}
		return []notificationTarget{target}, nil
	}
	lead := l.targeter().LeadSlug()
	owner := ""
	if l.broker != nil {
		owner = l.taskOwnerForMessage(msg)
	}
	enabledMembers := map[string]struct{}{}
	disabledMembers := map[string]struct{}{}
	if l.broker != nil {
		for _, member := range l.broker.EnabledMembers(msg.Channel) {
			enabledMembers[member] = struct{}{}
		}
		for _, member := range l.broker.DisabledMembers(msg.Channel) {
			disabledMembers[member] = struct{}{}
		}
	}

	// isExplicit checks whether a slug was explicitly @-tagged by the sender.
	// Explicit tags bypass the enabledMembers filter so a newly hired specialist
	// not yet in ch.Members can still be reached. They do NOT bypass ch.Disabled:
	// an explicit disable is the user's intent to silence the bot, and an
	// @-tag must not override it.
	isExplicit := func(slug string) bool { return containsSlug(msg.Tagged, slug) }

	addImmediate := func(slug string) {
		if slug == "" || slug == msg.From {
			return
		}
		if _, muted := disabledMembers[slug]; muted {
			return
		}
		if !isExplicit(slug) && len(enabledMembers) > 0 {
			if _, ok := enabledMembers[slug]; !ok {
				return
			}
		}
		if target, ok := targetMap[slug]; ok {
			immediate = append(immediate, target)
			delete(targetMap, slug)
		}
	}
	allowTarget := func(slug string) bool {
		if slug == "" || slug == msg.From {
			return false
		}
		if _, muted := disabledMembers[slug]; muted {
			return false
		}
		explicit := isExplicit(slug)
		if !explicit && len(enabledMembers) > 0 {
			if _, ok := enabledMembers[slug]; !ok {
				return false
			}
		}
		if slug == lead {
			return true
		}
		// Explicit @-tag: always allow regardless of domain. Domain inference is
		// for implicit routing only — it should never suppress an explicit mention.
		if explicit {
			return true
		}
		if owner != "" {
			return slug == owner
		}
		if strings.TrimSpace(msg.Content) == "" && strings.TrimSpace(msg.Title) == "" {
			return false
		}
		return l.messageTargetsBot(msg, slug)
	}

	// Focus mode (delegation): CEO routes all work. Specialists only wake
	// when explicitly tagged by CEO or human. No cross-bot chatter.
	if l.isFocusModeEnabled() {
		switch {
		case isHumanMessageSender(msg.From) || msg.Kind == "automation" || msg.From == "nex":
			// When the human explicitly @tags one or more specialists, deliver directly
			// to those specialists only. CEO does not need to re-route explicit assignments —
			// the specialist is already awake and acting. CEO only sees untagged human messages
			// (general questions, requests that need routing decisions).
			humanExplicitlyTaggedSpecialists := false
			for _, slug := range msg.Tagged {
				if slug == "" || slug == msg.From || slug == lead {
					continue
				}
				// Respect explicit disables. A muted specialist stays muted
				// even when @-tagged — muting is the user's explicit intent.
				if _, muted := disabledMembers[slug]; muted {
					continue
				}
				// Explicit @-tag trumps channel-membership. The specialist
				// may have been hired after #general was seeded and not yet
				// added to ch.Members; dropping the notification here would
				// silently re-route the human's direct address to CEO.
				if target, ok := targetMap[slug]; ok {
					immediate = append(immediate, target)
					delete(targetMap, slug)
					humanExplicitlyTaggedSpecialists = true
				}
			}
			// Wake the CEO when either no specialist was tagged (it routes the
			// request) or the human explicitly @mentioned it (an explicit
			// address always wakes, even alongside a tagged specialist).
			if !humanExplicitlyTaggedSpecialists || containsSlug(msg.Tagged, lead) {
				addImmediate(lead)
			}
		case msg.From == lead:
			for _, slug := range msg.Tagged {
				if slug != lead && allowTarget(slug) {
					addImmediate(slug)
				}
			}
		default:
			// Specialist message: wake only the bots the specialist
			// explicitly @-tagged (the CEO included, when tagged). An
			// untagged specialist message — a [STATUS] progress ping or a
			// richer live-stream note posted for human visibility — never
			// wakes the CEO. No teammate is listening on an untagged bot
			// message, so a bot that needs the CEO must @-tag it.
			for _, slug := range msg.Tagged {
				if slug != msg.From && allowTarget(slug) {
					addImmediate(slug)
				}
			}
		}
		return immediate, delayed
	}

	// Collaborative mode: all bots can see domain-relevant messages
	switch {
	case isHumanMessageSender(msg.From) || msg.Kind == "automation" || msg.From == "nex":
		// @all: notify every bot immediately.
		if containsSlug(msg.Tagged, "all") {
			addImmediate(lead)
			for slug := range targetMap {
				addImmediate(slug)
			}
			break
		}
		addImmediate(lead)
		if owner != "" && owner != lead && allowTarget(owner) {
			addImmediate(owner)
		}
		for _, slug := range msg.Tagged {
			if allowTarget(slug) {
				addImmediate(slug)
			}
		}
	case msg.From == lead:
		for _, slug := range msg.Tagged {
			if allowTarget(slug) {
				addImmediate(slug)
			}
		}
	case containsSlug(msg.Tagged, lead):
		addImmediate(lead)
		if owner != "" && owner != lead && allowTarget(owner) {
			addImmediate(owner)
		}
		for _, slug := range msg.Tagged {
			if allowTarget(slug) {
				addImmediate(slug)
			}
		}
	default:
		// Specialist-to-channel message that does NOT tag the CEO: an
		// untagged bot message never wakes the CEO. Wake the task owner
		// and any explicitly tagged bots only. A bot that needs the
		// CEO must @-tag it (handled by the msg.Tagged-contains-lead case
		// above).
		if owner != "" && owner != lead && allowTarget(owner) {
			addImmediate(owner)
		}
		for _, slug := range msg.Tagged {
			if allowTarget(slug) {
				addImmediate(slug)
			}
		}
	}
	return immediate, delayed
}
