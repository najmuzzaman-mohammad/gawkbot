package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/nex-crm/wuphf/cmd/wuphf/channelui"
	"github.com/nex-crm/wuphf/internal/brokeraddr"
	"github.com/nex-crm/wuphf/internal/company"
	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/internal/team"
	"github.com/nex-crm/wuphf/internal/tui"
)

type channelMsg struct {
	messages []channelui.BrokerMessage
}

type channelMembersMsg struct {
	members []channelui.Member
}

type channelOfficeMembersMsg struct {
	members []channelui.OfficeMember
}

type channelChannelsMsg struct {
	channels []channelui.ChannelInfo
}

type channelRequestsMsg struct {
	requests []channelui.Interview
	pending  *channelui.Interview
}

type channelTasksMsg struct {
	tasks []channelui.Task
}

type channelActionsMsg struct {
	actions []channelui.Action
}

type channelSignalsMsg struct {
	signals []channelui.Signal
}

type channelDecisionsMsg struct {
	decisions []channelui.Decision
}

type channelWatchdogsMsg struct {
	alerts []channelui.Watchdog
}

type channelSchedulerMsg struct {
	jobs []channelui.SchedulerJob
}

type channelSkillsMsg struct {
	skills []channelui.Skill
}

type channelUsageMsg struct {
	usage channelui.UsageState
}

type channelHealthMsg struct {
	Connected   bool
	SessionMode string
	OneOnOneBot string
}

type channelTickMsg time.Time
type channelPostDoneMsg struct {
	err    error
	notice string
	action string
	slug   string
}
type channelInterviewAnswerDoneMsg struct{ err error }
type channelCancelDoneMsg struct {
	requestID string
	err       error
}
type channelInterruptDoneMsg struct{ err error }
type channelResetDoneMsg struct {
	err         error
	notice      string
	sessionMode string
	oneOnOneBot string
}
type channelResetDMDoneMsg struct {
	err     error
	removed int
}
type channelDMCreatedMsg struct {
	err     error
	slug    string // deterministic DM slug e.g. "engineering__human"
	botSlug string // bot side of the DM
	name    string // display name
}
type channelInitDoneMsg struct {
	err    error
	notice string
}
type telegramDiscoverMsg struct {
	botName string
	groups  []team.TelegramGroup
	token   string
	err     error
}
type telegramConnectDoneMsg struct {
	channelSlug string
	groupTitle  string
	err         error
}

// openclawSessionOption is the minimal session data we retain for the picker.
type openclawSessionOption struct {
	SessionKey string
	Label      string
	Preview    string
}

type openclawSessionsMsg struct {
	sessions []openclawSessionOption
	err      error
}

type openclawConnectDoneMsg struct {
	slug  string
	label string
	err   error
}

type channelTaskMutationDoneMsg struct {
	notice string
	err    error
}

type channelMemberDraftDoneMsg struct {
	err    error
	notice string
}

type channelMemberDraft struct {
	Mode         string
	OriginalSlug string
	Step         int
	Slug         string
	Name         string
	Role         string
	Expertise    string
	Personality  string
}

var brokerTokenPath = brokeraddr.DefaultTokenFile

var channelSlashCommands = []tui.SlashCommand{
	{Name: "init", Description: "Run setup. Nothing is watching you yet", Category: "setup"},
	{Name: "provider", Description: "Switch LLM provider (choose wisely, Michael)", Category: "setup"},
	{Name: "doctor", Description: "Check readiness and runtime health (Meredith not involved)", Category: "setup"},
	{Name: "integrate", Description: "Connect an integration. More to look at", Category: "setup"},
	{Name: "connect", Description: "Bring Telegram, OpenClaw, or other integrations onto the team", Category: "setup"},
	{Name: "1o1", Description: "Direct 1:1 with a bot. The others pretend not to listen", Category: "session"},
	{Name: "messages", Description: "Show the main office feed — where it all happens", Category: "navigate"},
	{Name: "inbox", Description: "Show the selected bot inbox lane in 1:1 mode", Category: "navigate"},
	{Name: "outbox", Description: "Show the selected bot outbox lane in 1:1 mode", Category: "navigate"},
	{Name: "recover", Description: "Session recovery. Someone was watching, so nothing is lost", Category: "navigate"},
	{Name: "resume", Description: "Alias for /recover", Category: "navigate"},
	{Name: "rewind", Description: "Catch up from here. They already saw it", Category: "navigate"},
	{Name: "search", Description: "Search channels, tasks, requests. Somebody took notes", Category: "navigate"},
	{Name: "insert", Description: "Insert a channel, task, request, or message reference", Category: "navigate"},
	{Name: "switcher", Description: "Switch rooms and DMs. The staring follows you", Category: "navigate"},
	{Name: "tasks", Description: "Show active work. Everyone is watching it too", Category: "navigate"},
	{Name: "switch", Description: "Switch to another channel", Category: "navigate"},
	{Name: "channels", Description: "Browse and manage channels", Category: "navigate"},
	{Name: "channel", Description: "Create or remove a channel", Category: "channels"},
	{Name: "bots", Description: "Manage your team (no downsizing announcements)", Category: "people"},
	{Name: "bot", Description: "Add, remove, enable, or disable a teammate", Category: "people"},
	{Name: "bot prompt", Description: "New teammate from a prompt — Ryan calls this 'disruption'", Category: "people"},
	{Name: "task", Description: "Claim, release, or complete a task — ownership matters here", Category: "work"},
	{Name: "policies", Description: "Signals, watchdogs, decisions — no beet farm required", Category: "navigate"},
	{Name: "calendar", Description: "Office schedule — more reliable than Michael's personal calendar", Category: "navigate"},
	{Name: "queue", Description: "Alias for /calendar", Category: "navigate"},
	{Name: "artifacts", Description: "Task logs, approvals, and artifacts. The receipts", Category: "navigate"},
	{Name: "skills", Description: "Show available skills. Each bot watches one thing well", Category: "navigate"},
	{Name: "skill", Description: "Create, invoke, or manage a skill — the team gets smarter over time", Category: "work"},
	{Name: "reply", Description: "Reply in thread — threads keep context, unlike forwarded email chains", Category: "conversation"},
	{Name: "threads", Description: "Browse threads — the antidote to 'per my last email'", Category: "conversation"},
	{Name: "expand", Description: "Expand a collapsed thread — Michael never collapses anything", Category: "conversation"},
	{Name: "collapse", Description: "Collapse a thread. Out of sight, briefly", Category: "conversation"},
	{Name: "cancel", Description: "Exit current mode — that's what she said (probably)", Category: "conversation"},
	{Name: "collab", Description: "Open-floor mode: everyone hears everything", Category: "session"},
	{Name: "focus", Description: "Delegation mode — Chief of Staff routes, specialists execute (that's how it was always meant to work)", Category: "session"},
	{Name: "reset", Description: "Reset channel and bots", Category: "session"},
	{Name: "reset-dm", Description: "Clear direct messages with a bot", Category: "session"},
	{Name: "quit", Description: "Exit gawkbot — Michael would make a speech first", Category: "session"},
}

// oneOnOneBlacklist lists command names blocked in 1:1 mode.
var oneOnOneBlacklist = map[string]bool{
	"tasks":      true,
	"task":       true,
	"channels":   true,
	"channel":    true,
	"bots":       true,
	"bot":        true,
	"bot prompt": true,
	"reply":      true,
	"threads":    true,
	"expand":     true,
	"collapse":   true,
	"collab":     true,
	"focus":      true,
}

func buildOneOnOneSlashCommands() []tui.SlashCommand {
	var cmds []tui.SlashCommand
	for _, cmd := range channelSlashCommands {
		if oneOnOneBlacklist[cmd.Name] {
			continue
		}
		cmds = append(cmds, cmd)
	}
	return cmds
}

type channelPickerMode string

const (
	channelPickerNone            channelPickerMode = ""
	channelPickerInitProvider    channelPickerMode = "init_provider"
	channelPickerInitBlueprint   channelPickerMode = "init_blueprint"
	channelPickerInitPack        channelPickerMode = "init_pack" // legacy alias
	channelPickerProvider        channelPickerMode = "provider"
	channelPickerRequests        channelPickerMode = "requests"
	channelPickerTasks           channelPickerMode = "tasks"
	channelPickerTaskAction      channelPickerMode = "task_action"
	channelPickerRequestAction   channelPickerMode = "request_action"
	channelPickerThreads         channelPickerMode = "threads"
	channelPickerThreadAction    channelPickerMode = "thread_action"
	channelPickerChannels        channelPickerMode = "channels"
	channelPickerSwitcher        channelPickerMode = "switcher"
	channelPickerInsert          channelPickerMode = "insert"
	channelPickerSearch          channelPickerMode = "search"
	channelPickerRewind          channelPickerMode = "rewind"
	channelPickerBots            channelPickerMode = "agents"
	channelPickerCalendarBot     channelPickerMode = "calendar_agent"
	channelPickerOneOnOneMode    channelPickerMode = "one_on_one_mode"
	channelPickerOneOnOneBot     channelPickerMode = "one_on_one_agent"
	channelPickerTelegramGroup   channelPickerMode = "telegram_group"
	channelPickerConnect         channelPickerMode = "connect"
	channelPickerTelegramToken   channelPickerMode = "telegram_token"
	channelPickerTelegramChatID  channelPickerMode = "telegram_chat_id"
	channelPickerOpenclawURL     channelPickerMode = "openclaw-url"
	channelPickerOpenclawToken   channelPickerMode = "openclaw-token"
	channelPickerOpenclawSession channelPickerMode = "openclaw-session"
)

type quickJumpTarget string

const (
	quickJumpNone     quickJumpTarget = ""
	quickJumpChannels quickJumpTarget = "channels"
	quickJumpApps     quickJumpTarget = "apps"
)

// focusArea identifies which panel currently owns keyboard input.
type focusArea int

const (
	focusMain    focusArea = 0
	focusSidebar focusArea = 1
	focusThread  focusArea = 2
)

type channelModel struct {
	messages             []channelui.BrokerMessage
	members              []channelui.Member
	officeMembers        []channelui.OfficeMember
	channels             []channelui.ChannelInfo
	requests             []channelui.Interview
	tasks                []channelui.Task
	actions              []channelui.Action
	signals              []channelui.Signal
	decisions            []channelui.Decision
	watchdogs            []channelui.Watchdog
	scheduler            []channelui.SchedulerJob
	skills               []channelui.Skill
	pending              *channelui.Interview
	lastID               string
	activeChannel        string
	activeApp            channelui.OfficeApp
	replyToID            string
	expandedThreads      map[string]bool
	clickableThreads     map[int]string // rendered line index → message ID for click-to-expand
	threadsDefaultExpand bool           // true = expand threads by default
	tickFrame            int            // incremented each tick for animations
	autocomplete         tui.AutocompleteModel
	mention              tui.MentionModel
	input                []rune
	inputPos             int
	inputHistory         channelui.History
	width                int
	height               int
	scroll               int
	unreadCount          int
	unreadAnchorID       string
	awaySummary          string
	posting              bool
	selectedOption       int
	notice               string
	noticeExpireAt       time.Time
	confirm              *channelui.ChannelConfirm
	doctor               *channelui.DoctorReport
	memberDraft          *channelMemberDraft
	initFlow             tui.InitFlowModel
	picker               tui.PickerModel
	pickerMode           channelPickerMode

	// 3-column layout state
	focus               focusArea
	sidebarCollapsed    bool
	sidebarCursor       int
	sidebarRosterOffset int
	threadPanelOpen     bool
	threadPanelID       string
	threadInput         []rune
	threadInputPos      int
	threadInputHistory  channelui.History
	threadScroll        int
	usage               channelui.UsageState
	brokerConnected     bool
	sessionMode         string
	oneOnOneBot         string
	lastCtrlCAt         time.Time
	quickJumpTarget     quickJumpTarget
	calendarRange       channelui.CalendarRange
	calendarFilter      string

	// Telegram connect flow state
	telegramGroups []team.TelegramGroup
	telegramToken  string

	// OpenClaw connect flow state
	openclawURL      string
	openclawToken    string
	openclawSessions []openclawSessionOption

	// lastBotContent tracks the latest streaming text per bot for sidebar display.
	lastBotContent map[string]string

	// onboardingChecklist holds the "Getting started" checklist rendered in the sidebar.
	onboardingChecklist onboardingChecklist
}

func newChannelModel(threadsCollapsed bool) channelModel {
	return newChannelModelWithApp(threadsCollapsed, channelui.OfficeAppMessages)
}

func newChannelModelWithApp(threadsCollapsed bool, initialApp channelui.OfficeApp) channelModel {
	manifest, _ := company.LoadManifest()
	officeMembers := channelui.OfficeMembersFromManifest(manifest)
	channels := channelui.ChannelInfosFromManifest(manifest)
	sessionMode := team.SessionModeOffice
	oneOnOneBot := ""
	if strings.EqualFold(strings.TrimSpace(os.Getenv("WUPHF_ONE_ON_ONE")), "1") || strings.EqualFold(strings.TrimSpace(os.Getenv("WUPHF_ONE_ON_ONE")), "true") {
		sessionMode = team.SessionModeOneOnOne
		oneOnOneBot = strings.TrimSpace(os.Getenv("WUPHF_ONE_ON_ONE_AGENT"))
		if oneOnOneBot == "" {
			oneOnOneBot = team.DefaultOneOnOneBot
		}
		initialApp = channelui.OfficeAppMessages
	}
	channelui.SetOfficeDirectory(officeMembers)
	m := channelModel{
		expandedThreads:      make(map[string]bool),
		threadsDefaultExpand: !threadsCollapsed,
		autocomplete:         tui.NewAutocomplete(channelSlashCommands),
		mention:              tui.NewMention(channelMentionBots(nil)),
		inputHistory:         channelui.NewHistory(),
		initFlow:             tui.NewInitFlow(),
		activeChannel:        "general",
		activeApp:            initialApp,
		calendarRange:        channelui.CalendarRangeWeek,
		officeMembers:        officeMembers,
		channels:             channels,
		sessionMode:          sessionMode,
		oneOnOneBot:          oneOnOneBot,
		threadInputHistory:   channelui.NewHistory(),
		lastBotContent:       make(map[string]string),
	}
	if m.isOneOnOne() {
		m.sidebarCollapsed = true
		m.threadsDefaultExpand = true
		m.autocomplete = tui.NewAutocomplete(buildOneOnOneSlashCommands())
		m.notice = "Direct session reset. Bot pane reloaded in place. Nobody else is looking."
	}
	memoryStatus := team.ResolveMemoryBackendStatus()
	if memoryStatus.SelectedKind == config.MemoryBackendNone {
		m.notice = "Running without an external memory backend for this session."
	} else if memoryStatus.SelectedKind == config.MemoryBackendGBrain && strings.TrimSpace(config.ResolveOpenAIAPIKey()) == "" && strings.TrimSpace(config.ResolveAnthropicAPIKey()) == "" {
		m.notice = "No OpenAI or Anthropic API key configured for GBrain. Starting setup..."
		m.initFlow, _ = m.initFlow.Start()
	} else if memoryStatus.SelectedKind == config.MemoryBackendGBrain && memoryStatus.ActiveKind == config.MemoryBackendNone && strings.TrimSpace(memoryStatus.Detail) != "" {
		m.notice = memoryStatus.Detail
	}
	m.syncSidebarCursorToActive()
	return m
}

// setTransientNotice sets a notice that auto-clears after the next few ticks.
func (m *channelModel) setTransientNotice(text string) {
	m.notice = text
	m.noticeExpireAt = time.Now().Add(4 * time.Second)
}

func (m channelModel) isOneOnOne() bool {
	return team.NormalizeSessionMode(m.sessionMode) == team.SessionModeOneOnOne
}

func (m channelModel) oneOnOneBotSlug() string {
	return team.NormalizeOneOnOneBot(m.oneOnOneBot)
}

func (m channelModel) oneOnOneBotName() string {
	slug := m.oneOnOneBotSlug()
	for _, member := range channelui.MergeOfficeMembers(m.officeMembers, m.members, nil) {
		if member.Slug == slug && strings.TrimSpace(member.Name) != "" {
			return member.Name
		}
	}
	return channelui.DisplayName(slug)
}

func (m *channelModel) refreshSlashCommands() {
	var activeInput []rune
	activeCursor := 0
	preserveOverlays := false
	if m.focus == focusThread && m.threadPanelOpen {
		activeInput = append([]rune(nil), m.threadInput...)
		activeCursor = m.threadInputPos
		preserveOverlays = true
	} else if m.focus == focusMain {
		activeInput = append([]rune(nil), m.input...)
		activeCursor = m.inputPos
		preserveOverlays = true
	}
	var base []tui.SlashCommand
	if m.isOneOnOne() {
		base = buildOneOnOneSlashCommands()
	} else {
		base = make([]tui.SlashCommand, len(channelSlashCommands))
		copy(base, channelSlashCommands)
	}
	var skillCommands []tui.SlashCommand
	for _, sk := range m.skills {
		if sk.Status != "active" {
			continue
		}
		skillCommands = append(skillCommands, tui.SlashCommand{
			Name:        sk.Name,
			Description: sk.Description,
			Category:    "skills",
		})
	}
	base = append(skillCommands, base...)
	m.autocomplete = tui.NewAutocomplete(base)
	if preserveOverlays {
		m.updateOverlaysForInput(activeInput, activeCursor)
		return
	}
	m.updateOverlaysForCurrentInput()
}

func (m channelModel) pollCurrentState() tea.Cmd {
	if m.isOneOnOne() {
		return tea.Sequence(
			pollHealth(),
			pollBroker(m.lastID, m.activeChannel),
			pollMembers(m.activeChannel),
			tickChannel(),
		)
	}
	return tea.Sequence(
		pollHealth(),
		pollChannels(),
		pollOfficeMembers(),
		pollBroker(m.lastID, m.activeChannel),
		pollMembers(m.activeChannel),
		pollRequests(m.activeChannel),
		pollTasks(m.activeChannel),
		pollSkills(""),
		pollOfficeLedger(),
		pollUsage(),
		tickChannel(),
	)
}

func (m channelModel) Init() tea.Cmd {
	m.lastID = ""
	return m.pollCurrentState()
}

func (m channelModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, tea.ClearScreen

	case tea.MouseMsg:
		return m.handleMouseMsg(msg)

	case tea.KeyMsg:
		return m.handleKeyMsg(msg)

	case channelPostDoneMsg:
		return m.handleChannelPostDoneMsg(msg)

	case channelInterviewAnswerDoneMsg:
		return m.handleChannelInterviewAnswerDoneMsg(msg)

	case channelCancelDoneMsg:
		return m.handleChannelCancelDoneMsg(msg)

	case channelInterruptDoneMsg:
		return m.handleChannelInterruptDoneMsg(msg)

	case channelResetDoneMsg:
		return m.handleChannelResetDoneMsg(msg)

	case channelResetDMDoneMsg:
		return m.handleChannelResetDMDoneMsg(msg)

	case channelDMCreatedMsg:
		return m.handleChannelDMCreatedMsg(msg)

	case channelInitDoneMsg:
		return m.handleChannelInitDoneMsg(msg)

	case channelDoctorDoneMsg:
		return m.handleChannelDoctorDoneMsg(msg)

	case telegramDiscoverMsg:
		return m.handleTelegramDiscoverMsg(msg)

	case openclawSessionsMsg:
		return m.handleOpenclawSessionsMsg(msg)

	case openclawConnectDoneMsg:
		return m.handleOpenclawConnectDoneMsg(msg)

	case telegramConnectDoneMsg:
		return m.handleTelegramConnectDoneMsg(msg)

	case channelMemberDraftDoneMsg:
		return m.handleChannelMemberDraftDoneMsg(msg)

	case channelTaskMutationDoneMsg:
		return m.handleChannelTaskMutationDoneMsg(msg)

	case channelMsg:
		return m.handleChannelMsg(msg)

	case channelMembersMsg:
		return m.handleChannelMembersMsg(msg)

	case channelOfficeMembersMsg:
		return m.handleChannelOfficeMembersMsg(msg)

	case channelChannelsMsg:
		return m.handleChannelChannelsMsg(msg)

	case channelUsageMsg:
		return m.handleChannelUsageMsg(msg)

	case channelHealthMsg:
		return m.handleChannelHealthMsg(msg)

	case channelTasksMsg:
		return m.handleChannelTasksMsg(msg)

	case channelSkillsMsg:
		return m.handleChannelSkillsMsg(msg)

	case channelActionsMsg:
		return m.handleChannelActionsMsg(msg)

	case channelSignalsMsg:
		return m.handleChannelSignalsMsg(msg)

	case channelDecisionsMsg:
		return m.handleChannelDecisionsMsg(msg)

	case channelWatchdogsMsg:
		return m.handleChannelWatchdogsMsg(msg)

	case channelSchedulerMsg:
		return m.handleChannelSchedulerMsg(msg)

	case tui.PickerSelectMsg:
		return m.handlePickerSelectMsg(msg)

	case tui.InitFlowMsg:
		return m.handleInitFlowMsg(msg)

	case channelRequestsMsg:
		return m.handleChannelRequestsMsg(msg)

	case channelTickMsg:
		return m.handleChannelTickMsg(msg)
	}

	return m, nil
}

// View() moved to channel_view.go.

// Header rendering queries (currentHeaderTitle, currentHeaderMeta,
// currentAppLabel, currentMainLines) moved to channel_header.go.
// Pure state queries (visiblePendingRequest, composerTargetLabel,
// recommendedOptionIndex, interviewOptionCount, selectedInterviewOption,
// nextFocus) moved to channel_state_queries.go.

// Mouse hit-testing (mouseAction type, mouseActionAt, mainPanelMouseAction),
// main-panel geometry (mainPanelGeometry), and the recovery-prompt click
// handler (applyRecoveryPrompt) all moved to channel_mouse.go.

// Sidebar state, items, cursor, selection, and the updateSidebar key
// handler all live in channel_sidebar_state.go.

// Picker option builders moved to channel_pickers.go.

// Lookup helpers + request-action dispatch moved to channel_lookups.go.

// Composer input helpers and thread keymap moved to channel_composer_input.go.

// runActiveCommand, runCommand, and maybeActivateChannelPickerFromInput moved
// to channel_commands.go.

func (m channelModel) renderActivePopup(width int) string {
	if width < 24 {
		width = 24
	}
	if m.autocomplete.IsVisible() {
		var options []channelui.ComposerPopupOption
		for _, cmd := range m.autocomplete.Matches() {
			meta := cmd.Description
			if strings.TrimSpace(cmd.Category) != "" {
				meta = strings.ToUpper(cmd.Category) + " · " + meta
			}
			options = append(options, channelui.ComposerPopupOption{
				Label: "/" + cmd.Name,
				Meta:  meta,
			})
		}
		return channelui.RenderComposerPopup(options, m.autocomplete.SelectedIndex(), width, channelui.SlackActive)
	}
	if m.mention.IsVisible() {
		var options []channelui.ComposerPopupOption
		for _, ag := range m.mention.Matches() {
			options = append(options, channelui.ComposerPopupOption{
				Label: "@" + ag.Slug,
				Meta:  ag.Name,
			})
		}
		return channelui.RenderComposerPopup(options, m.mention.SelectedIndex(), width, "#2BAC76")
	}
	return ""
}

func (m channelModel) currentChannelInfo() *channelui.ChannelInfo {
	return m.findChannelInfo(m.activeChannel)
}

func (m channelModel) findChannelInfo(slug string) *channelui.ChannelInfo {
	for i := range m.channels {
		if m.channels[i].Slug == slug {
			return &m.channels[i]
		}
	}
	return nil
}

func (m channelModel) buildChannelPickerOptions() []tui.PickerOption {
	var options []tui.PickerOption
	for _, ch := range m.channels {
		description := strings.TrimSpace(ch.Description)
		if description == "" {
			description = fmt.Sprintf("%d members", len(ch.Members))
		} else {
			description = fmt.Sprintf("%s · %d members", description, len(ch.Members))
		}
		options = append(options, tui.PickerOption{
			Label:       "#" + ch.Slug,
			Value:       "switch:" + ch.Slug,
			Description: description,
		})
		if ch.Slug != "general" {
			options = append(options, tui.PickerOption{
				Label:       "Remove #" + ch.Slug,
				Value:       "remove:" + ch.Slug,
				Description: "Delete this channel and its messages/tasks",
			})
		}
	}
	return options
}

func (m channelModel) buildSwitchChannelPickerOptions() []tui.PickerOption {
	options := []tui.PickerOption{
		{Label: "Main office feed", Value: "app:messages", Description: "Return to the shared message stream"},
		{Label: "Tasks", Value: "app:tasks", Description: "Review active work for this channel"},
		{Label: "Requests", Value: "app:requests", Description: "Open pending approvals and interviews"},
		{Label: "Policies", Value: "app:policies", Description: "Show signals, decisions, and watchdogs"},
		{Label: "Calendar", Value: "app:calendar", Description: "View the team schedule and teammate calendars"},
	}
	if m.isOneOnOne() {
		options = append(options, tui.PickerOption{
			Label:       "Return to main office",
			Value:       "session:office",
			Description: "Leave direct mode and restore the shared office session",
		})
	} else {
		for _, member := range m.officeMembers {
			name := strings.TrimSpace(member.Name)
			if name == "" {
				name = channelui.DisplayName(member.Slug)
			}
			options = append(options, tui.PickerOption{
				Label:       "1:1 with " + name,
				Value:       "session:1o1:" + member.Slug,
				Description: "Jump into a direct session with " + name,
			})
		}
	}
	for _, option := range m.buildChannelPickerOptions() {
		if strings.HasPrefix(option.Value, "switch:") {
			options = append(options, option)
		}
	}
	return options
}

func (m channelModel) buildBotPickerOptions() []tui.PickerOption {
	ch := m.currentChannelInfo()
	if ch == nil {
		return nil
	}
	officeMap := make(map[string]channelui.OfficeMember, len(m.officeMembers))
	for _, member := range m.officeMembers {
		officeMap[member.Slug] = member
	}
	disabled := make(map[string]bool, len(ch.Disabled))
	for _, slug := range ch.Disabled {
		disabled[slug] = true
	}
	var options []tui.PickerOption
	for _, slug := range ch.Members {
		name := channelui.DisplayName(slug)
		if meta, ok := officeMap[slug]; ok && meta.Name != "" {
			name = meta.Name
		}
		if slug != "ceo" && disabled[slug] {
			options = append(options, tui.PickerOption{
				Label:       "Enable " + name,
				Value:       "enable:" + slug,
				Description: "Allow this teammate to participate in #" + m.activeChannel,
			})
		} else if slug != "ceo" {
			options = append(options, tui.PickerOption{
				Label:       "Disable " + name,
				Value:       "disable:" + slug,
				Description: "Keep them in the channel but stop notifications there",
			})
		}
		if slug != "ceo" {
			options = append(options, tui.PickerOption{
				Label:       "Remove " + name,
				Value:       "remove:" + slug,
				Description: "Take them out of #" + m.activeChannel,
			})
		}
	}
	for _, member := range m.officeMembers {
		slug := member.Slug
		found := false
		for _, member := range ch.Members {
			if member == slug {
				found = true
				break
			}
		}
		if !found {
			options = append(options, tui.PickerOption{
				Label:       "Add " + member.Name,
				Value:       "add:" + slug,
				Description: "Add them to #" + m.activeChannel,
			})
		}
		if !member.BuiltIn {
			options = append(options, tui.PickerOption{
				Label:       "Edit " + member.Name,
				Value:       "edit:" + slug,
				Description: "Update role, expertise, personality, and permissions",
			})
		}
	}
	options = append(options, tui.PickerOption{
		Label:       "Create new office member…",
		Value:       "create:new",
		Description: "Use /bot create <slug> <Display Name> to add a brand-new teammate",
	})
	return options
}

func (m channelModel) buildOneOnOneModePickerOptions() []tui.PickerOption {
	enableDescription := "Restart gawkbot in direct mode with one selected bot and kill the rest of the Claude sessions"
	if m.isOneOnOne() {
		enableDescription = "Pick a different single bot for this direct session"
	}
	disableDescription := "Restart gawkbot with the full office team"
	if !m.isOneOnOne() {
		disableDescription = "Already using the full office team"
	}
	return []tui.PickerOption{
		{
			Label:       "Enable 1:1 mode",
			Value:       "enable",
			Description: enableDescription,
		},
		{
			Label:       "Disable 1:1 mode",
			Value:       "disable",
			Description: disableDescription,
		},
	}
}

func (m channelModel) buildOneOnOneBotPickerOptions() []tui.PickerOption {
	options := make([]tui.PickerOption, 0, len(m.officeMembers))
	for _, member := range m.officeMembers {
		name := member.Name
		if strings.TrimSpace(name) == "" {
			name = channelui.DisplayName(member.Slug)
		}
		description := strings.TrimSpace(member.Role)
		if description == "" {
			description = "Direct session with " + name
		}
		options = append(options, tui.PickerOption{
			Label:       name,
			Value:       member.Slug,
			Description: description,
		})
	}
	return options
}

func (m channelModel) buildCalendarBotPickerOptions() []tui.PickerOption {
	options := []tui.PickerOption{{
		Label:       "All teammates",
		Value:       "all",
		Description: "Show every participant across the team calendar",
	}}
	for _, member := range m.members {
		name := member.Name
		if strings.TrimSpace(name) == "" {
			name = channelui.DisplayName(member.Slug)
		}
		description := member.Role
		if strings.TrimSpace(description) == "" {
			description = "Show only " + name + "'s calendar"
		}
		options = append(options, tui.PickerOption{
			Label:       name,
			Value:       member.Slug,
			Description: description,
		})
	}
	return options
}

// HTTP/network commands moved to channel_broker.go.

// Process lifecycle helpers moved to channel_lifecycle.go.
