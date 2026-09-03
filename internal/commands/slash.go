package commands

// RegisterAllCommands populates r with the full set of slash commands.
//
// WebSupported flags are set against the web composer's current handler set
// (web/src/components/messages/Composer.tsx). Flip WebSupported on a command
// the moment a web handler exists; leave it off until then. This is the
// source of truth for what the web autocomplete shows — see
// broker_commands.go / GET /commands.
func RegisterAllCommands(r *Registry) {
	// AI
	r.Register(SlashCommand{Name: "ask", Description: "Ask the team lead", WebSupported: true})
	r.Register(SlashCommand{Name: "lookup", Description: "Cited answer from the team wiki", WebSupported: true})
	r.Register(SlashCommand{Name: "search", Description: "Search messages + KB", WebSupported: true})
	r.Register(SlashCommand{Name: "remember", Description: "Store a fact in memory", WebSupported: true})
	r.Register(SlashCommand{Name: "youtube-pack", Description: "Generate YouTube content packages", Execute: cmdYouTubePack})

	r.Register(SlashCommand{Name: "task", Description: "Task actions (claim/release/complete/block/approve)", WebSupported: true})

	// Views
	r.Register(SlashCommand{Name: "calendar", Description: "View schedule", WebSupported: true, Execute: cmdCalendar})
	r.Register(SlashCommand{Name: "chat", Description: "Switch to chat view"})
	r.Register(SlashCommand{Name: "messages", Description: "Show the main office feed"})
	r.Register(SlashCommand{Name: "inbox", Description: "Show the selected bot inbox lane in 1:1 mode"})
	r.Register(SlashCommand{Name: "outbox", Description: "Show the selected bot outbox lane in 1:1 mode"})
	r.Register(SlashCommand{Name: "rewind", Description: "Catch up from here"})
	r.Register(SlashCommand{Name: "insert", Description: "Insert a channel, task, request, or message reference"})
	r.Register(SlashCommand{Name: "switcher", Description: "Switch office/direct or workspace destination"})
	r.Register(SlashCommand{Name: "switch", Description: "Switch to another channel"})
	r.Register(SlashCommand{Name: "channels", Description: "Browse and manage channels"})
	r.Register(SlashCommand{Name: "channel", Description: "Create or remove a channel"})
	r.Register(SlashCommand{Name: "queue", Description: "Alias for /calendar"})
	r.Register(SlashCommand{Name: "artifacts", Description: "View task logs, approvals, and workflow artifacts"})

	// Bots
	r.Register(SlashCommand{Name: "bot", Description: "Bot commands (list/details/create/edit/remove/prompt)", Execute: cmdBot})
	r.Register(SlashCommand{Name: "bots", Description: "Manage your team"})

	// Config
	r.Register(SlashCommand{Name: "config", Description: "Config commands (show/set/path)", Execute: cmdConfig})
	r.Register(SlashCommand{Name: "detect", Description: "Detect installed AI platforms", Execute: cmdDetect})
	r.Register(SlashCommand{Name: "doctor", Description: "Check readiness and runtime health", WebSupported: true, Execute: cmdDoctor})
	r.Register(SlashCommand{Name: "integrate", Description: "Connect a managed integration"})
	r.Register(SlashCommand{Name: "init", Description: "Run setup", Execute: cmdInit})
	r.Register(SlashCommand{Name: "provider", Description: "Switch runtime provider", WebSupported: true, Execute: cmdProvider})

	// System
	r.Register(SlashCommand{Name: "help", Description: "Show all commands + keys", WebSupported: true, Execute: cmdHelp})
	r.Register(SlashCommand{Name: "clear", Description: "Clear messages", WebSupported: true, Execute: cmdClear})
	r.Register(SlashCommand{Name: "quit", Description: "Exit WUPHF", Execute: cmdQuit})

	// Wiki intelligence
	r.Register(SlashCommand{Name: "lint", Description: "Run wiki lint — checks contradictions, orphans, stale claims, cross-refs", WebSupported: true})

	// Apps — bot-generated internal tools, built by the App Builder bot.
	r.Register(SlashCommand{Name: "create-app", Description: "Build a new internal tool (App Builder)", WebSupported: true})
	r.Register(SlashCommand{Name: "update-app", Description: "Improve an existing app (App Builder)", WebSupported: true})

	// Channel workflows
	r.Register(SlashCommand{Name: "request", Description: "Request commands (focus/answer/dismiss)"})
	r.Register(SlashCommand{Name: "reply", Description: "Reply in thread"})
	r.Register(SlashCommand{Name: "expand", Description: "Expand a collapsed thread"})
	r.Register(SlashCommand{Name: "collapse", Description: "Collapse a thread"})
	r.Register(SlashCommand{Name: "skill", Description: "Create, invoke, or manage a skill"})
	r.Register(SlashCommand{Name: "reset-dm", Description: "Clear direct messages with a bot"})

	// Web-only surfaces. No TUI Execute handler yet; the web composer owns the
	// behaviour (navigate to a view, post to /signals, etc). Listed here so
	// GET /commands — the single source of truth for the web autocomplete —
	// keeps them discoverable. See Composer.tsx's handleSlashCommand switch.
	r.Register(SlashCommand{Name: "reset", Description: "Reset the team", WebSupported: true})
	r.Register(SlashCommand{Name: "requests", Description: "Open requests", WebSupported: true})
	r.Register(SlashCommand{Name: "policies", Description: "View policies", WebSupported: true})
	r.Register(SlashCommand{Name: "skills", Description: "View skills", WebSupported: true})
	r.Register(SlashCommand{Name: "tasks", Description: "Open task board", WebSupported: true})
	r.Register(SlashCommand{Name: "recover", Description: "Health Check view", WebSupported: true})
	r.Register(SlashCommand{Name: "threads", Description: "See every active thread", WebSupported: true})
	r.Register(SlashCommand{Name: "focus", Description: "Switch to delegation mode", WebSupported: true})
	r.Register(SlashCommand{Name: "collab", Description: "Switch to collaborative mode", WebSupported: true})
	r.Register(SlashCommand{Name: "pause", Description: "Pause all bots", WebSupported: true})
	r.Register(SlashCommand{Name: "resume", Description: "Resume all bots", WebSupported: true})
	r.Register(SlashCommand{Name: "1o1", Description: "1:1 with bot", WebSupported: true})
	r.Register(SlashCommand{Name: "cancel", Description: "Cancel a task", WebSupported: true})
	r.Register(SlashCommand{Name: "connect", Description: "Connect a Telegram chat to the team", WebSupported: true})
}
