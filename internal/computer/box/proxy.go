package box

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/nex-crm/wuphf/internal/computer"
)

// The cloud proxy is the MCP server a bot CLI spawns for a box. Every
// action goes through the box's REST command endpoint (no inbound port, no
// tunnel), so a round trip is expensive. The whole design is one round
// trip per step: act, settle, capture, and base64 run in a single shell
// command, and the frame rides back in the same tool result as an image
// block. The bot never needs a follow-up screenshot call.
//
// Ported from milind-soni/OpenMausBot server/computer-proxy.ts, minus the
// Chrome DevTools browser tools, which are a follow-up.

const (
	settleMs      = 600
	actionGapMs   = 120
	inlineMaxByte = 700_000
)

var keysPattern = regexp.MustCompile(`[^\w+]`)

// Proxy is the running server state.
type Proxy struct {
	client *Client
	boxID  string
	gate   *computer.GateClient
}

// MCPLaunch is the spawn contract for a box-backed "computer" server.
func MCPLaunch(binary, boxID, token string, control computer.ControlEndpoint) computer.MCPLaunch {
	launch := computer.MCPLaunch{
		Command: binary,
		Args:    []string{"computer-mcp", "box", boxID},
		Env:     map[string]string{"WUPHF_BOX_API_KEY": token},
	}
	if control.URL != "" && control.Token != "" {
		launch.Env["WUPHF_COMPUTER_CONTROL_URL"] = control.URL
		launch.Env["WUPHF_COMPUTER_CONTROL_TOKEN"] = control.Token
	}
	return launch
}

// RunProxy serves the cloud computer tools over stdio until the bot
// closes the transport.
func RunProxy(ctx context.Context, client *Client, boxID string, gate *computer.GateClient) error {
	if !client.Configured() {
		return fmt.Errorf("WUPHF_BOX_API_KEY is not set")
	}
	if boxID == "" {
		return fmt.Errorf("box id is required")
	}
	p := &Proxy{client: client, boxID: boxID, gate: gate}
	server := mcp.NewServer(&mcp.Implementation{Name: "gawkbot-computer", Version: "0.1.0"}, nil)
	p.register(server)
	return server.Run(ctx, &mcp.StdioTransport{})
}

type screenshotArgs struct{}

type clickArgs struct {
	X      float64 `json:"x" jsonschema:"x in screenshot coordinates"`
	Y      float64 `json:"y" jsonschema:"y in screenshot coordinates"`
	Button string  `json:"button,omitempty" jsonschema:"left or right"`
	Double bool    `json:"double,omitempty" jsonschema:"double-click"`
}

type typeArgs struct {
	Text string `json:"text" jsonschema:"the text to type into the focused field"`
}

type keyArgs struct {
	Keys string `json:"keys" jsonschema:"a key or chord such as Return, Tab, ctrl+l, alt+F4"`
}

type scrollArgs struct {
	Direction string  `json:"direction,omitempty" jsonschema:"up or down"`
	Clicks    float64 `json:"clicks,omitempty" jsonschema:"wheel clicks, 1 to 20"`
}

type batchAction struct {
	Action    string  `json:"action" jsonschema:"click, type_text, press_key, scroll, or wait"`
	X         float64 `json:"x,omitempty"`
	Y         float64 `json:"y,omitempty"`
	Button    string  `json:"button,omitempty"`
	Double    bool    `json:"double,omitempty"`
	Text      string  `json:"text,omitempty"`
	Keys      string  `json:"keys,omitempty"`
	Direction string  `json:"direction,omitempty"`
	Clicks    float64 `json:"clicks,omitempty"`
	Ms        float64 `json:"ms,omitempty"`
}

type batchArgs struct {
	Actions []batchAction `json:"actions" jsonschema:"up to 24 actions run in order with one screenshot at the end"`
}

type execArgs struct {
	Command string `json:"command" jsonschema:"a shell command run on the computer as the desktop user"`
}

type openURLArgs struct {
	URL string `json:"url" jsonschema:"an http(s) URL to open in Chrome"`
}

type waitArgs struct {
	Ms float64 `json:"ms,omitempty" jsonschema:"milliseconds to wait, up to 5000"`
}

type helpArgs struct {
	Reason string `json:"reason" jsonschema:"one sentence: what you need the person to do and where"`
}

func (p *Proxy) register(s *mcp.Server) {
	mcp.AddTool(s, &mcp.Tool{Name: "screenshot", Description: "Capture the whole screen. Returns an image; coordinates for click are in this image's pixel space."}, p.screenshot)
	mcp.AddTool(s, &mcp.Tool{Name: "click", Description: "Click at screenshot coordinates, then settle and return a fresh screenshot."}, p.click)
	mcp.AddTool(s, &mcp.Tool{Name: "type_text", Description: "Type text into the focused field, then return a fresh screenshot. Click the field first."}, p.typeText)
	mcp.AddTool(s, &mcp.Tool{Name: "press_key", Description: "Press a key or chord (Return, Tab, Escape, ctrl+l, alt+F4), then return a fresh screenshot."}, p.pressKey)
	mcp.AddTool(s, &mcp.Tool{Name: "scroll", Description: "Scroll the screen center up or down by wheel clicks, then return a fresh screenshot."}, p.scroll)
	mcp.AddTool(s, &mcp.Tool{Name: "computer_batch", Description: "Run a mechanical sequence (click, type_text, press_key, scroll, wait) in one round trip with one screenshot at the end. Use it for forms: click, type, tab, type, Return."}, p.batch)
	mcp.AddTool(s, &mcp.Tool{Name: "computer_exec", Description: "Run a shell command on the computer and return its output. The disk persists; /home is yours."}, p.exec)
	mcp.AddTool(s, &mcp.Tool{Name: "open_url", Description: "Open a URL in Chrome on the computer, then return a screenshot."}, p.openURL)
	mcp.AddTool(s, &mcp.Tool{Name: "wait_for", Description: "Wait up to five seconds for the screen to settle, then return a screenshot."}, p.waitFor)
	mcp.AddTool(s, &mcp.Tool{Name: "computer_status", Description: "Report whether the desktop driver is healthy."}, p.status)
	mcp.AddTool(s, &mcp.Tool{Name: computer.HelpToolName, Description: "Ask the person watching this computer to take control for a moment (a login, a CAPTCHA, a judgment call). Blocks until they hand control back, dismiss, or ten minutes pass."}, p.requestHelp)
}

// failed reports a transport or provider error to the model as a tool
// error result. The MCP call itself succeeded, so the Go error is consumed
// here on purpose: returning it would make the SDK drop the explanatory text.
func failed(prefix string, err error) (*mcp.CallToolResult, any, error) {
	return textResult(prefix+err.Error(), true), nil, nil
}

func textResult(text string, isError bool) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, IsError: isError}
}

func (p *Proxy) held(ctx context.Context) bool {
	return p.gate.Configured() && p.gate.State(ctx, true).Held
}

// ── shell building ──────────────────────────────────────────────────────

const envPrefix = `export DISPLAY=${DISPLAY:-:0}; export HOME=${HOME:-/root}`
const geometry = `W=$(xdotool getdisplaygeometry 2>/dev/null | cut -d" " -f1); H=$(xdotool getdisplaygeometry 2>/dev/null | cut -d" " -f2); case "$W" in ""|*[!0-9]*) W=0;; esac; case "$H" in ""|*[!0-9]*) H=0;; esac`
const cuaEnv = "CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0"

func scaled(name string, value float64) string {
	v := int(math.Round(value))
	return fmt.Sprintf(`if [ "$W" -gt %d ] 2>/dev/null; then %s=$(( %d * W / %d )); else %s=%d; fi`, ShotWidth, name, v, ShotWidth, name, v)
}

// cuaOrX11 prefers the official driver and keeps the proven X11 command as
// a degraded path while a first install finishes.
func cuaOrX11(tool, argsShell, fallback string) string {
	return strings.Join([]string{
		"if [ -x " + RemoteCuaExecutable + " ] && " + RemoteCuaExecutable + " status --socket " + RemoteCuaSocket + " >/dev/null 2>&1;",
		"then if env " + cuaEnv + " " + RemoteCuaExecutable + " call " + tool + " " + argsShell + " --socket " + RemoteCuaSocket + " >/dev/null 2>/tmp/gawkbot-cua-call.error;",
		`then echo "BACKEND CUA"; else ` + fallback + `; X11_RC=$?; echo "BACKEND X11"; [ "$X11_RC" -eq 0 ]; fi`,
		"else " + fallback + `; X11_RC=$?; echo "BACKEND X11"; [ "$X11_RC" -eq 0 ]; fi`,
	}, " ")
}

func captureBlock(settle int) string {
	sleep := "true"
	if settle > 0 {
		sleep = fmt.Sprintf("sleep %.2f", float64(settle)/1000)
	}
	return strings.Join([]string{
		sleep,
		"f=" + ShotPath,
		"raw=/tmp/gawkbot-shot.png",
		`rm -f "$f" "$raw" 2>/dev/null || true`,
		"if [ -x " + RemoteCuaExecutable + " ] && " + RemoteCuaExecutable + " status --socket " + RemoteCuaSocket + " >/dev/null 2>&1 && env " + cuaEnv + " " + RemoteCuaExecutable + " call get_desktop_state " + ShellQuote(`{"scope":"desktop","session":"`+RemoteCuaSession+`"}`) + " --socket " + RemoteCuaSocket + ` --screenshot-out-file "$raw" >/dev/null 2>&1 && command -v convert >/dev/null 2>&1 && convert "$raw" -quality ` + strconv.Itoa(jpegQuality) + ` "$f" 2>/dev/null; then echo "CAPTURE CUA"; else scrot -o -q ` + strconv.Itoa(jpegQuality) + ` "$f" 2>/dev/null || import -window root -quality ` + strconv.Itoa(jpegQuality) + ` "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 -q:v 6 "$f" >/dev/null 2>&1; echo "CAPTURE X11"; fi`,
		fmt.Sprintf(`if [ "$W" -gt %d ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -thumbnail %dx -quality %d "$f" 2>/dev/null || true; fi`, ShotWidth, ShotWidth, jpegQuality),
		`if [ ! -s "$f" ]; then echo SHOT_FAILED; exit 0; fi`,
		`echo "GEOM $W $H"`,
		`s=$(stat -c%s "$f" 2>/dev/null || echo 0)`,
		`echo "SIZE $s"`,
		fmt.Sprintf(`if [ "$s" -gt 0 ] && [ "$s" -le %d ]; then echo "B64 $(base64 -w0 "$f" 2>/dev/null || base64 "$f" | tr -d '\n')"; fi`, inlineMaxByte),
	}, "; ")
}

func actionShell(a batchAction) (string, error) {
	switch a.Action {
	case "click":
		if math.IsNaN(a.X) || math.IsNaN(a.Y) {
			return "", fmt.Errorf("click needs numeric x,y")
		}
		button, btn, count, rep := "left", 1, 1, ""
		if a.Button == "right" {
			button, btn = "right", 3
		}
		if a.Double {
			count, rep = 2, "--repeat 2 --delay 60 "
		}
		fallback := fmt.Sprintf("xdotool mousemove $CX $CY click %s%d", rep, btn)
		args := fmt.Sprintf(`$(printf '{"x":%%s,"y":%%s,"button":"%s","count":%d,"scope":"desktop","session":"%s"}' "$CX" "$CY")`, button, count, RemoteCuaSession)
		return scaled("CX", a.X) + "; " + scaled("CY", a.Y) + "; CUA_ARGS=" + args + "; " + cuaOrX11("click", `"$CUA_ARGS"`, fallback), nil
	case "type_text":
		if a.Text == "" {
			return "", fmt.Errorf("type_text needs text")
		}
		payload := ShellQuote(fmt.Sprintf(`{"text":%s,"scope":"desktop","session":"%s"}`, jsonString(a.Text), RemoteCuaSession))
		return cuaOrX11("type_text", payload, "xdotool type --clearmodifiers --delay 8 -- "+ShellQuote(a.Text)), nil
	case "press_key":
		keys := keysPattern.ReplaceAllString(a.Keys, "")
		if keys == "" {
			return "", fmt.Errorf("press_key needs keys")
		}
		parts := strings.Split(keys, "+")
		tool, payload := "press_key", fmt.Sprintf(`{"key":%s,"scope":"desktop","session":"%s"}`, jsonString(strings.ToLower(parts[0])), RemoteCuaSession)
		if len(parts) > 1 {
			quoted := make([]string, 0, len(parts))
			for _, part := range parts {
				quoted = append(quoted, jsonString(part))
			}
			tool, payload = "hotkey", fmt.Sprintf(`{"keys":[%s],"scope":"desktop","session":"%s"}`, strings.Join(quoted, ","), RemoteCuaSession)
		}
		return cuaOrX11(tool, ShellQuote(payload), "xdotool key "+keys), nil
	case "scroll":
		clicks := int(math.Min(math.Max(math.Round(a.Clicks), 1), 20))
		if a.Clicks == 0 {
			clicks = 3
		}
		direction, btn := "down", 5
		if a.Direction == "up" {
			direction, btn = "up", 4
		}
		fallback := fmt.Sprintf("xdotool click --repeat %d %d", clicks, btn)
		args := fmt.Sprintf(`$(printf '{"x":%%s,"y":%%s,"direction":"%s","amount":%d,"by":"line","scope":"desktop","session":"%s"}' "$((W / 2))" "$((H / 2))")`, direction, clicks, RemoteCuaSession)
		return "CUA_ARGS=" + args + "; " + cuaOrX11("scroll", `"$CUA_ARGS"`, fallback), nil
	case "wait":
		ms := math.Min(math.Max(a.Ms, 0), 5000)
		if a.Ms == 0 {
			ms = 500
		}
		return fmt.Sprintf("sleep %.2f", ms/1000), nil
	}
	return "", fmt.Errorf("unknown action %q", a.Action)
}

func jsonString(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// ── running commands ────────────────────────────────────────────────────

func (p *Proxy) run(ctx context.Context, command string, timeout time.Duration) (CommandResult, error) {
	res, err := p.client.Run(ctx, p.boxID, IsolatedCommand(command), timeout)
	var notRunning *NotRunningError
	if err != nil && asNotRunning(err, &notRunning) {
		// Boxes archive themselves when idle; wake it and carry on rather
		// than handing the bot a cryptic 409.
		if _, werr := p.client.WaitReady(ctx, p.boxID, 90*time.Second); werr == nil {
			return p.client.Run(ctx, p.boxID, IsolatedCommand(command), timeout)
		}
		return CommandResult{Stderr: "the computer is asleep and did not wake in time"}, nil
	}
	return res, err
}

func asNotRunning(err error, target **NotRunningError) bool {
	return errors.As(err, target)
}

func frameFrom(ctx context.Context, p *Proxy, out CommandResult) ([]byte, string) {
	if strings.Contains(out.Stdout, "SHOT_FAILED") {
		return nil, ""
	}
	geom := ""
	expected := 0
	var inline string
	for _, line := range strings.Split(out.Stdout, "\n") {
		switch {
		case strings.HasPrefix(line, "GEOM "):
			geom = strings.TrimPrefix(line, "GEOM ")
		case strings.HasPrefix(line, "SIZE "):
			expected, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "SIZE ")))
		case strings.HasPrefix(line, "B64 "):
			inline = strings.TrimSpace(strings.TrimPrefix(line, "B64 "))
		}
	}
	var raw []byte
	if inline != "" {
		if b, err := base64.StdEncoding.DecodeString(inline); err == nil && (expected == 0 || len(b) == expected) && wholeJPEG(b) {
			raw = b
		}
	}
	if raw == nil {
		data, err := p.client.ReadFileBase64(ctx, p.boxID, ShotPath)
		if err != nil {
			return nil, geom
		}
		b, err := base64.StdEncoding.DecodeString(data)
		if err != nil || !wholeJPEG(b) {
			return nil, geom
		}
		raw = b
	}
	return raw, geom
}

func wholeJPEG(b []byte) bool {
	if len(b) < 512 || b[0] != 0xff || b[1] != 0xd8 {
		return false
	}
	tail := b[len(b)-32:]
	for i := 0; i+1 < len(tail); i++ {
		if tail[i] == 0xff && tail[i+1] == 0xd9 {
			return true
		}
	}
	return false
}

func observed(note string, frame []byte, geom string) *mcp.CallToolResult {
	if frame == nil {
		return textResult(note+"\n(no frame could be captured; call screenshot)", false)
	}
	text := note
	if geom != "" {
		text += "\n(display " + geom + "; coordinates below are in the image's pixel space)"
	}
	return &mcp.CallToolResult{Content: []mcp.Content{
		&mcp.TextContent{Text: text},
		&mcp.ImageContent{Data: frame, MIMEType: "image/jpeg"},
	}}
}

func (p *Proxy) actAndObserve(ctx context.Context, actions []batchAction, note string, timeout time.Duration) (*mcp.CallToolResult, any, error) {
	if p.held(ctx) {
		return textResult(computer.ControlRefusal, true), nil, nil
	}
	parts := make([]string, 0, len(actions)*2)
	for _, a := range actions {
		shell, err := actionShell(a)
		if err != nil {
			return textResult(err.Error(), true), nil, nil
		}
		if len(parts) > 0 {
			parts = append(parts, fmt.Sprintf("sleep %.2f", float64(actionGapMs)/1000))
		}
		parts = append(parts, shell)
	}
	guarded := "if { " + strings.Join(parts, "; ") + "; }; then ACT=ok; else ACT=failed; fi"
	command := strings.Join([]string{envPrefix, geometry, EnsureCuaCommand(), guarded, captureBlock(settleMs), `echo "ACT $ACT"`}, "; ")
	out, err := p.run(ctx, command, timeout)
	if err != nil {
		return failed(note+" failed: ", err)
	}
	acted := strings.Contains(out.Stdout, "ACT ok")
	if !acted && !strings.Contains(out.Stdout, "GEOM") {
		return textResult(fmt.Sprintf("%s failed: %s", note, firstNonEmpty(strings.TrimSpace(tail(out.Stderr, 200)), "no detail")), true), nil, nil
	}
	backend := "Cua Driver"
	if strings.Contains(out.Stdout, "BACKEND X11") {
		backend = "X11 fallback"
	}
	full := note + "\n(" + backend + ")"
	if !acted {
		full = note + "\n(the action reported an error: " + firstNonEmpty(strings.TrimSpace(tail(out.Stderr, 160)), "no detail") + "; " + backend + ")"
	}
	frame, geom := frameFrom(ctx, p, out)
	return observed(full, frame, geom), nil, nil
}

// ── tools ───────────────────────────────────────────────────────────────

func (p *Proxy) screenshot(ctx context.Context, _ *mcp.CallToolRequest, _ screenshotArgs) (*mcp.CallToolResult, any, error) {
	if p.held(ctx) {
		return textResult(computer.ControlRefusal, true), nil, nil
	}
	out, err := p.run(ctx, strings.Join([]string{envPrefix, geometry, EnsureCuaCommand(), captureBlock(0)}, "; "), 60*time.Second)
	if err != nil {
		return failed("screenshot failed: ", err)
	}
	frame, geom := frameFrom(ctx, p, out)
	if frame == nil {
		return textResult("screenshot failed: "+firstNonEmpty(strings.TrimSpace(tail(out.Stderr, 200)), "capture produced no frame"), true), nil, nil
	}
	return observed("screen captured", frame, geom), nil, nil
}

func (p *Proxy) click(ctx context.Context, _ *mcp.CallToolRequest, a clickArgs) (*mcp.CallToolResult, any, error) {
	what := "clicked"
	if a.Double {
		what = "double-clicked"
	} else if a.Button == "right" {
		what = "right-clicked"
	}
	return p.actAndObserve(ctx, []batchAction{{Action: "click", X: a.X, Y: a.Y, Button: a.Button, Double: a.Double}}, fmt.Sprintf("%s %d,%d", what, int(math.Round(a.X)), int(math.Round(a.Y))), 60*time.Second)
}

func (p *Proxy) typeText(ctx context.Context, _ *mcp.CallToolRequest, a typeArgs) (*mcp.CallToolResult, any, error) {
	if a.Text == "" {
		return textResult("nothing to type", true), nil, nil
	}
	return p.actAndObserve(ctx, []batchAction{{Action: "type_text", Text: a.Text}}, fmt.Sprintf("typed %d chars", len(a.Text)), 120*time.Second)
}

func (p *Proxy) pressKey(ctx context.Context, _ *mcp.CallToolRequest, a keyArgs) (*mcp.CallToolResult, any, error) {
	keys := keysPattern.ReplaceAllString(a.Keys, "")
	if keys == "" {
		return textResult("press_key needs keys", true), nil, nil
	}
	return p.actAndObserve(ctx, []batchAction{{Action: "press_key", Keys: keys}}, "pressed "+keys, 60*time.Second)
}

func (p *Proxy) scroll(ctx context.Context, _ *mcp.CallToolRequest, a scrollArgs) (*mcp.CallToolResult, any, error) {
	direction := "down"
	if a.Direction == "up" {
		direction = "up"
	}
	return p.actAndObserve(ctx, []batchAction{{Action: "scroll", Direction: direction, Clicks: a.Clicks}}, "scrolled "+direction, 60*time.Second)
}

func (p *Proxy) batch(ctx context.Context, _ *mcp.CallToolRequest, a batchArgs) (*mcp.CallToolResult, any, error) {
	if len(a.Actions) == 0 {
		return textResult("computer_batch needs a non-empty actions array", true), nil, nil
	}
	actions := a.Actions
	if len(actions) > 24 {
		actions = actions[:24]
	}
	summary := make([]string, 0, len(actions))
	for _, act := range actions {
		switch act.Action {
		case "click":
			summary = append(summary, fmt.Sprintf("click %d,%d", int(math.Round(act.X)), int(math.Round(act.Y))))
		case "type_text":
			summary = append(summary, fmt.Sprintf("type %d chars", len(act.Text)))
		case "press_key":
			summary = append(summary, "key "+act.Keys)
		case "scroll":
			summary = append(summary, "scroll "+firstNonEmpty(act.Direction, "down"))
		default:
			summary = append(summary, "wait")
		}
	}
	return p.actAndObserve(ctx, actions, fmt.Sprintf("ran %d actions: %s", len(actions), strings.Join(summary, " → ")), 180*time.Second)
}

func (p *Proxy) exec(ctx context.Context, _ *mcp.CallToolRequest, a execArgs) (*mcp.CallToolResult, any, error) {
	if p.held(ctx) {
		return textResult(computer.ControlRefusal, true), nil, nil
	}
	cmd := strings.TrimSpace(a.Command)
	if cmd == "" {
		return textResult("computer_exec needs a command", true), nil, nil
	}
	if len(cmd) > MaxCommandLength {
		return textResult(fmt.Sprintf("command is too long (maximum %d characters)", MaxCommandLength), true), nil, nil
	}
	out, err := p.run(ctx, cmd, 120*time.Second)
	if err != nil {
		return failed("command failed: ", err)
	}
	code := 0
	if out.ExitCode != nil {
		code = *out.ExitCode
	}
	text := fmt.Sprintf("exit %d\n%s", code, tail(out.Stdout, 12000))
	if strings.TrimSpace(out.Stderr) != "" {
		text += "\n[stderr]\n" + tail(out.Stderr, 4000)
	}
	return textResult(text, code != 0), nil, nil
}

func (p *Proxy) openURL(ctx context.Context, _ *mcp.CallToolRequest, a openURLArgs) (*mcp.CallToolResult, any, error) {
	u := strings.TrimSpace(a.URL)
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return textResult("open_url needs an http(s) URL", true), nil, nil
	}
	if p.held(ctx) {
		return textResult(computer.ControlRefusal, true), nil, nil
	}
	open := "(google-chrome --no-first-run --password-store=basic " + ShellQuote(u) + " >/dev/null 2>&1 || chromium " + ShellQuote(u) + " >/dev/null 2>&1 || xdg-open " + ShellQuote(u) + " >/dev/null 2>&1) &"
	command := strings.Join([]string{envPrefix, geometry, open, "sleep 2.5", captureBlock(settleMs)}, "; ")
	out, err := p.run(ctx, command, 60*time.Second)
	if err != nil {
		return failed("open_url failed: ", err)
	}
	frame, geom := frameFrom(ctx, p, out)
	return observed("opened "+u, frame, geom), nil, nil
}

func (p *Proxy) waitFor(ctx context.Context, _ *mcp.CallToolRequest, a waitArgs) (*mcp.CallToolResult, any, error) {
	ms := int(math.Min(math.Max(a.Ms, 0), 5000))
	if ms == 0 {
		ms = 1000
	}
	if p.held(ctx) {
		return textResult(computer.ControlRefusal, true), nil, nil
	}
	out, err := p.run(ctx, strings.Join([]string{envPrefix, geometry, captureBlock(ms)}, "; "), 60*time.Second)
	if err != nil {
		return failed("wait_for failed: ", err)
	}
	frame, geom := frameFrom(ctx, p, out)
	return observed(fmt.Sprintf("waited %dms", ms), frame, geom), nil, nil
}

func (p *Proxy) status(ctx context.Context, _ *mcp.CallToolRequest, _ screenshotArgs) (*mcp.CallToolResult, any, error) {
	command := strings.Join([]string{
		envPrefix,
		EnsureCuaCommand(),
		"if [ -x " + RemoteCuaExecutable + " ] && " + RemoteCuaExecutable + " status --socket " + RemoteCuaSocket + " >/dev/null 2>&1; then",
		`  echo "CUA $(` + RemoteCuaExecutable + ` --version)"`,
		"  env " + cuaEnv + " " + RemoteCuaExecutable + " call health_report '{}' --socket " + RemoteCuaSocket + " 2>/dev/null || true",
		"else echo 'X11 fallback'; fi",
	}, "\n")
	out, err := p.run(ctx, command, 20*time.Second)
	if err != nil {
		return failed("status failed: ", err)
	}
	if !strings.Contains(out.Stdout, "CUA ") {
		return textResult("Cloud computer automation: X11 fallback (Cua Driver is still installing or needs repair).", true), nil, nil
	}
	overall := "unknown"
	if m := regexp.MustCompile(`"overall"\s*:\s*"(ok|degraded|failed)"`).FindStringSubmatch(out.Stdout); m != nil {
		overall = m[1]
	}
	return textResult("Cloud computer automation: Cua Driver "+RemoteCuaVersion+" ("+overall+").", false), nil, nil
}

func (p *Proxy) requestHelp(ctx context.Context, _ *mcp.CallToolRequest, a helpArgs) (*mcp.CallToolResult, any, error) {
	if !p.gate.Configured() {
		return textResult("Help requests are not available for this computer. Explain what you need in your reply instead.", true), nil, nil
	}
	reason := strings.TrimSpace(a.Reason)
	if reason == "" {
		reason = "The bot needs your hands on its computer."
	}
	initial := p.gate.State(ctx, true)
	requestID := ""
	if !initial.Held {
		id, err := p.gate.RequestHelp(ctx, reason)
		if err != nil {
			return failed("Could not reach the app to ask for help: ", err)
		}
		requestID = id
	}
	sawHold := initial.Held
	deadline := time.Now().Add(computer.HelpWaitTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			if requestID != "" {
				p.gate.ExpireHelp(context.Background(), requestID)
			}
			return textResult("The turn ended before anyone answered.", true), nil, nil
		case <-time.After(2 * time.Second):
		}
		s := p.gate.State(ctx, true)
		if s.Held {
			sawHold = true
		}
		if !s.Held && !s.HelpOpen {
			if sawHold {
				return textResult("The person handled it and handed control back. Take a fresh screenshot before your next action.", false), nil, nil
			}
			return textResult("The person dismissed the request without taking control. Continue on your own or explain in your reply.", false), nil, nil
		}
	}
	if requestID != "" {
		p.gate.ExpireHelp(context.Background(), requestID)
	}
	return textResult("Nobody answered within "+computer.HelpWaitTimeout.String()+". Explain what you need in your reply and stop.", true), nil, nil
}
