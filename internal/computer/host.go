package computer

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/hostcomputer"
)

// The person's own Mac as a bot's computer. The bridge is the same stdio
// pipe as for a container, with three differences on the near side:
//
//  1. Only the tools in internal/hostcomputer's policy reach the driver;
//     everything else is refused before it leaves the bot's process.
//  2. Every call carries the bot's own session, so the driver shows a
//     cursor in the bot's colour, labelled with its name, that the person
//     can watch. Acting tools are ALWAYS delivered in the background: the
//     bot works through its own virtual cursor and never moves the
//     person's pointer or takes focus, so several bots can work at once
//     while the person keeps using the Mac. A bot cannot ask otherwise.
//  3. Before a bot's first action of a turn, the person is asked, in the
//     notch, unless they chose to always allow it.

// HostPolicy is what the bridge enforces for one bot on the Mac.
type HostPolicy struct {
	Slug  string
	Label string
	Color string
	// AlwaysAllow skips the per-turn consent (the person's own choice).
	AlwaysAllow bool
}

// ConsentWaitTimeout bounds how long a bot waits for the person's answer
// before giving up on the turn's actions.
var ConsentWaitTimeout = 2 * time.Minute

// ConsentRefusal is what the model reads when the person said no, or
// nobody answered.
const ConsentRefusal = "The person did not allow you to use their Mac this turn. Do not try again; explain what you wanted to do in your reply."

// ConsentPending is the summary shown while the bridge asks.
const consentSummary = "wants to click and type on this Mac"

// HostMCPLaunch builds the MCP entry for a bot on the Mac: this binary
// bridging into the app-owned driver socket. The driver path and the
// control pair ride in env, not argv.
func HostMCPLaunch(binary, driver, socket, slug string, control ControlEndpoint) MCPLaunch {
	launch := MCPLaunch{
		Command: binary,
		Args:    []string{"computer-mcp", "--host", socket, slug},
		Env: map[string]string{
			"GAWKBOT_CUA_DRIVER":  driver,
			"CUA_DRIVER_EMBEDDED": "1",
		},
	}
	if control.URL != "" && control.Token != "" {
		launch.Env["WUPHF_COMPUTER_CONTROL_URL"] = control.URL
		launch.Env["WUPHF_COMPUTER_CONTROL_TOKEN"] = control.Token
	}
	return launch
}

// ValidHostBridgeArgs checks the argv of the host form.
func ValidHostBridgeArgs(socket, slug string) error {
	if !strings.HasPrefix(socket, hostcomputer.SocketPrefix()) || strings.Contains(socket, "..") {
		return fmt.Errorf("invalid driver socket")
	}
	if slug == "" || len(slug) > 64 || !validContainerName(slug) {
		return fmt.Errorf("invalid bot slug")
	}
	return nil
}

// Session ids the bridge uses for its own requests to the driver; the
// bot never sees them.
const (
	bridgeSessionStartID = `"gawk:session"`
	bridgeCursorID       = `"gawk:cursor"`
	bridgeEndID          = `"gawk:end"`
)

// hostToolsFilter keeps only the tools a bot may call on the Mac.
func hostToolsFilter(tools []json.RawMessage) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(tools))
	for _, raw := range tools {
		var t struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &t) == nil && hostcomputer.KindOf(t.Name) != hostcomputer.ToolDenied {
			out = append(out, raw)
		}
	}
	return out
}

// hostCall prepares one bot call for the driver: policy, session, delivery.
// It returns the line to forward, or a refusal to emit.
func (g *gateInterceptor) hostCall(ctx context.Context, frame rpcFrame, name string, args map[string]any) (forward string, refusal string) {
	kind := hostcomputer.KindOf(name)
	if kind == hostcomputer.ToolDenied {
		return "", "The tool " + name + " is not available on the person's Mac. Use the window, element, cursor and page tools instead."
	}
	if args == nil {
		args = map[string]any{}
	}
	args["session"] = g.host.Slug
	if kind == hostcomputer.ToolAct {
		if !g.consentFor(ctx) {
			return "", ConsentRefusal
		}
		// Forced, not defaulted: the person's pointer and focus are theirs.
		args["delivery_mode"] = hostcomputer.DeliveryBackground
	}
	params, _ := json.Marshal(map[string]any{"name": name, "arguments": args})
	out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": frame.ID, "method": "tools/call", "params": json.RawMessage(params)})
	return string(out), ""
}

// consentFor asks once per turn and waits for the person's answer.
func (g *gateInterceptor) consentFor(ctx context.Context) bool {
	g.mu.Lock()
	decided, allowed := g.consentDecided, g.consentAllowed
	g.mu.Unlock()
	if decided {
		return allowed
	}
	allowed = g.askConsent(ctx)
	g.mu.Lock()
	g.consentDecided, g.consentAllowed = true, allowed
	g.mu.Unlock()
	return allowed
}

func (g *gateInterceptor) askConsent(ctx context.Context) bool {
	if g.host.AlwaysAllow {
		return true
	}
	if !g.gate.Configured() {
		return false
	}
	id, err := g.gate.RequestConsent(ctx, consentSummary)
	if err != nil {
		return false
	}
	deadline := time.Now().Add(ConsentWaitTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			g.gate.ExpireConsent(context.Background(), id)
			return false
		case <-time.After(helpPollInterval):
		}
		s := g.gate.State(ctx, true)
		if s.ConsentOpen {
			continue
		}
		return s.ConsentDecision == ConsentAllow || s.ConsentDecision == ConsentAllowAlways
	}
	g.gate.ExpireConsent(context.Background(), id)
	return false
}

// sessionStart is the bridge's own first calls after the driver answered
// initialize: declare the bot's session and dress its cursor.
func (g *gateInterceptor) sessionStart() []string {
	start, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(bridgeSessionStartID), "method": "tools/call",
		"params": map[string]any{"name": "start_session", "arguments": map[string]any{"session": g.host.Slug}}})
	style := map[string]any{"session": g.host.Slug, "cursor_id": g.host.Slug}
	if g.host.Label != "" {
		style["cursor_label"] = g.host.Label
	}
	if g.host.Color != "" {
		style["cursor_color"] = g.host.Color
	}
	cursor, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(bridgeCursorID), "method": "tools/call",
		"params": map[string]any{"name": "set_agent_cursor_motion", "arguments": style}})
	return []string{string(start), string(cursor)}
}

// sessionEnd removes the bot's cursor when its turn ends.
func (g *gateInterceptor) sessionEnd() string {
	end, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(bridgeEndID), "method": "tools/call",
		"params": map[string]any{"name": "end_session", "arguments": map[string]any{"session": g.host.Slug}}})
	return string(end)
}

// isBridgeID reports whether a response answers one of the bridge's own
// requests, which the bot must never see.
func isBridgeID(id json.RawMessage) bool {
	s := string(id)
	return s == bridgeSessionStartID || s == bridgeCursorID || s == bridgeEndID
}
