package hostcomputer

// The tools a bot may reach on the person's Mac. The bridge refuses every
// other name before it leaves the bot's process, whatever the driver would
// allow: perception stays read-only, actions go through the driver's input
// paths, and nothing here touches the clipboard, the browser's logged-in
// profile, the driver's configuration, or its recordings.

// Read tools look and never act.
var readTools = []string{
	"list_apps", "list_windows", "get_window_state", "get_accessibility_tree",
	"get_screen_size", "get_desktop_state", "zoom", "verify_state",
	"check_permissions", "get_cursor_position", "get_agent_cursor_state",
	"get_session", "get_session_state",
}

// Act tools change what is on screen; each one goes through consent.
var actTools = []string{
	"launch_app", "bring_to_front", "set_window_frame", "invoke_menu",
	"click", "double_click", "right_click", "drag", "type_text", "press_key",
	"hotkey", "set_value", "scroll", "run_steps",
}

// Cursor tools only move or dress the agent's own overlay cursor.
var cursorTools = []string{
	"start_session", "end_session", "move_cursor", "set_agent_cursor_enabled",
	"set_agent_cursor_motion", "set_agent_cursor_theme",
}

// ToolKind classifies a tool name for the bridge.
type ToolKind int

const (
	// ToolDenied is a tool bots may not call on the Mac.
	ToolDenied ToolKind = iota
	// ToolRead observes without acting.
	ToolRead
	// ToolAct changes the screen and needs consent for the turn.
	ToolAct
	// ToolCursor drives the agent's overlay cursor only.
	ToolCursor
)

var toolKinds = func() map[string]ToolKind {
	m := map[string]ToolKind{}
	for _, t := range readTools {
		m[t] = ToolRead
	}
	for _, t := range actTools {
		m[t] = ToolAct
	}
	for _, t := range cursorTools {
		m[t] = ToolCursor
	}
	return m
}()

// KindOf classifies a tool; unknown names are denied.
func KindOf(tool string) ToolKind { return toolKinds[tool] }

// AllowedTools lists every tool a bot may call, for the bridge's filtered
// tools/list.
func AllowedTools() []string {
	out := make([]string, 0, len(toolKinds))
	out = append(out, readTools...)
	out = append(out, actTools...)
	out = append(out, cursorTools...)
	return out
}

// Delivery modes the driver accepts on acting tools.
const (
	// DeliveryBackground posts input to the app without taking focus or
	// moving the real pointer; the bot's virtual cursor shows where it
	// works. The only mode bots get on the person's Mac.
	DeliveryBackground = "background"
)
