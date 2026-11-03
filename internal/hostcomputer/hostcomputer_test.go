package hostcomputer

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeDriver answers tool calls from a table, as the daemon's proxy would.
type fakeDriver struct {
	mu      sync.Mutex
	calls   []string
	answers map[string]Result
}

func (f *fakeDriver) Call(_ context.Context, tool string, _ map[string]any) (Result, error) {
	f.mu.Lock()
	f.calls = append(f.calls, tool)
	f.mu.Unlock()
	if r, ok := f.answers[tool]; ok {
		return r, nil
	}
	return Result{Text: "no such tool: " + tool, IsError: true}, nil
}

func structured(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestDaemonContractIsEmbeddedAndShortSocket(t *testing.T) {
	d := &Daemon{Binary: "/x/cua-driver", Socket: SocketPath(), HostBundleID: "ai.nex.wuphf.desktop", Home: "/h"}
	args := strings.Join(d.Args(), " ")
	for _, want := range []string{"serve", "--embedded", "--socket " + SocketPath(), "--no-permissions-gate", "--host-bundle-id ai.nex.wuphf.desktop", "--no-overlay"} {
		if !strings.Contains(args, want) {
			t.Fatalf("args %q lack %q", args, want)
		}
	}
	d.Overlay = true
	if strings.Contains(strings.Join(d.Args(), " "), "--no-overlay") {
		t.Fatal("overlay on still passes --no-overlay")
	}
	env := strings.Join(d.Env(), "\n")
	for _, want := range []string{"CUA_DRIVER_EMBEDDED=1", "CUA_DRIVER_PERMISSION_MODE=standard", "CUA_DRIVER_HOST_BUNDLE_ID=ai.nex.wuphf.desktop", "CUA_DRIVER_RS_HOME=/h", "CUA_DRIVER_PARENT_LIVENESS_STDIN=1"} {
		if !strings.Contains(env, want) {
			t.Fatalf("env lacks %q", want)
		}
	}
	// macOS refuses Unix socket paths past ~104 bytes; keep ours far below.
	if len(SocketPath()) > 60 || !strings.HasPrefix(SocketPath(), "/tmp/gawkbot-cua-") {
		t.Fatalf("socket path %q", SocketPath())
	}
	if err := (&Daemon{}).Start(context.Background()); err == nil {
		t.Fatal("a daemon with no binary started")
	}
}

func TestDaemonStopsWhenItsStdinCloses(t *testing.T) {
	// A stand-in for the driver: lives while stdin is open, listens on the socket.
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	socket := "/tmp/gawkbot-cua-test-" + strings.ReplaceAll(t.Name(), "/", "-")[:8] + ".sock"
	script := "nc -lU " + socket + " >/dev/null 2>&1 & p=$!; cat >/dev/null; kill $p 2>/dev/null; rm -f " + socket
	if _, err := exec.LookPath("nc"); err != nil {
		t.Skip("no nc")
	}
	d := &Daemon{Binary: sh, Socket: socket}
	d.Binary, d.argsOverride = sh, []string{"-c", script}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	if !d.Running() {
		t.Fatal("not running after start")
	}
	d.Stop()
	if d.Running() {
		t.Fatal("still running after stop")
	}
	if _, err := os.Stat(socket); err == nil {
		t.Fatal("socket left behind")
	}
}

func TestFrontmostUsesTheHighestZIndexOnScreen(t *testing.T) {
	z := func(n int) *int { return &n }
	wins := []Window{
		{WindowID: 1, Title: "hidden", ZIndex: z(900), OnScreen: false},
		{WindowID: 2, Title: "back", ZIndex: z(10), OnScreen: true},
		{WindowID: 3, Title: "front", ZIndex: z(248), OnScreen: true},
		{WindowID: 4, Title: "unknown stacking", OnScreen: true},
	}
	got, ok := Frontmost(wins)
	if !ok || got.WindowID != 3 {
		t.Fatalf("frontmost = %+v ok=%v", got, ok)
	}
	if _, ok := Frontmost(nil); ok {
		t.Fatal("no windows gave a frontmost")
	}
}

func TestWatcherReadsTheFrontAppWindowAndBrowserHost(t *testing.T) {
	f := &fakeDriver{answers: map[string]Result{
		"list_apps": {Structured: structured(t, map[string]any{"apps": []App{
			{Name: "Finder", BundleID: "com.apple.finder", PID: 10, Running: true},
			{Name: "Google Chrome", BundleID: "com.google.Chrome", PID: 20, Running: true, Active: true},
			{Name: "Old", BundleID: "x", PID: 0, Running: false, Active: true},
		}})},
		"list_windows": {Structured: structured(t, map[string]any{"windows": []map[string]any{
			{"window_id": 7, "pid": 20, "app_name": "Google Chrome", "title": "Inbox - Gmail", "z_index": 5, "is_on_screen": true},
			{"window_id": 8, "pid": 20, "app_name": "Google Chrome", "title": "PR #4097", "z_index": 9, "is_on_screen": true},
		}})},
		"get_window_state": {Structured: structured(t, map[string]any{"elements": []map[string]any{
			{"role": "AXTextField", "label": "Address and search bar", "value": "github.com/najmuzzaman-mohammad/gawkbot/pull/4097?tab=files#diff"},
		}})},
	}}
	w := NewWatcher(f)
	w.ReadURL = true
	w.SetActive(true)
	defer w.SetActive(false)
	sc, err := w.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sc.App != "Google Chrome" || sc.PID != 20 || sc.WindowID != 8 || sc.WindowTitle != "PR #4097" {
		t.Fatalf("context = %+v", sc)
	}
	if sc.URL != "https://github.com/najmuzzaman-mohammad/gawkbot/pull/4097" || sc.Domain != "github.com" {
		t.Fatalf("url/domain = %q %q (query and fragment must be dropped)", sc.URL, sc.Domain)
	}
	// The address bar is read once per window, not on every tick.
	if _, err := w.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	reads := 0
	f.mu.Lock()
	calls := append([]string{}, f.calls...)
	f.mu.Unlock()
	for _, c := range calls {
		if c == "get_window_state" {
			reads++
		}
	}
	if reads != 1 {
		t.Fatalf("address bar read %d times for the same window, want 1", reads)
	}
	if snap, ok := w.Snapshot(); !ok || snap.Domain != "github.com" {
		t.Fatalf("snapshot = %+v ok=%v", snap, ok)
	}
}

func TestWatcherPrefersTheShellsFrontmostApp(t *testing.T) {
	f := &fakeDriver{answers: map[string]Result{
		"list_apps":    {Structured: structured(t, map[string]any{"apps": []App{{Name: "Wrong", BundleID: "x", PID: 1, Running: true, Active: true}}})},
		"list_windows": {Structured: structured(t, map[string]any{"windows": []map[string]any{{"window_id": 9, "pid": 77, "app_name": "Notes", "title": "Groceries", "z_index": 1, "is_on_screen": true}}})},
	}}
	w := NewWatcher(f)
	w.Frontmost = func() (App, bool) {
		return App{Name: "Notes", BundleID: "com.apple.Notes", PID: 77, Running: true}, true
	}
	w.SetActive(true)
	defer w.SetActive(false)
	sc, err := w.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sc.App != "Notes" || sc.PID != 77 || sc.WindowTitle != "Groceries" {
		t.Fatalf("context = %+v", sc)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == "list_apps" {
			t.Fatal("asked the driver for apps when the shell already knew")
		}
	}
}

func TestWatcherForgetsEverythingWhenNobodyWatches(t *testing.T) {
	f := &fakeDriver{answers: map[string]Result{
		"list_apps":    {Structured: structured(t, map[string]any{"apps": []App{{Name: "Notes", BundleID: "com.apple.Notes", PID: 3, Running: true, Active: true}}})},
		"list_windows": {Structured: structured(t, map[string]any{"windows": []map[string]any{}})},
	}}
	w := NewWatcher(f)
	if _, ok := w.Snapshot(); ok {
		t.Fatal("a snapshot before anyone watched")
	}
	w.SetActive(true)
	if _, err := w.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sc, ok := w.Snapshot(); !ok || sc.App != "Notes" || sc.URL != "" {
		t.Fatalf("snapshot = %+v ok=%v", sc, ok)
	}
	w.SetActive(false)
	if _, ok := w.Snapshot(); ok || w.Active() {
		t.Fatal("snapshot survived the last watcher leaving")
	}
	w.SetActive(false) // one too many is harmless
}

func TestAddressBarFallsBackToTheTreeAndRefusesJunk(t *testing.T) {
	f := &fakeDriver{answers: map[string]Result{
		"get_window_state": {Structured: structured(t, map[string]any{
			"elements":      []map[string]any{{"role": "AXButton", "label": "Back"}},
			"tree_markdown": "- AXToolbar\n  - AXTextField \"Address and search bar\" value=\"https://linear.app/nex/issue/NEX-12?x=1\" [element_index 3]\n",
		})},
	}}
	got, err := AddressBarURL(context.Background(), f, 1, 2)
	if err != nil || got != "https://linear.app/nex/issue/NEX-12" {
		t.Fatalf("got %q err %v", got, err)
	}
	for _, junk := range []string{"", "search terms here", "not a url", "javascript:alert(1)"} {
		if normalizeURL(junk) != "" {
			t.Fatalf("%q normalised to %q", junk, normalizeURL(junk))
		}
	}
	if normalizeURL("mail.google.com/mail/u/0/#inbox") != "https://mail.google.com/mail/u/0/" {
		t.Fatalf("bare host = %q", normalizeURL("mail.google.com/mail/u/0/#inbox"))
	}
	if DomainOf("https://www.notion.so/x") != "notion.so" {
		t.Fatal("www not trimmed")
	}
	denied := &fakeDriver{answers: map[string]Result{"get_window_state": {Text: "Accessibility is not granted", IsError: true}}}
	if got, err := AddressBarURL(context.Background(), denied, 1, 2); got != "" || err == nil {
		t.Fatalf("denied read gave %q err %v", got, err)
	}
}

func TestPolicyClassifiesEveryToolABotMayUse(t *testing.T) {
	cases := map[string]ToolKind{
		"get_window_state": ToolRead, "click": ToolAct, "run_steps": ToolAct, "move_cursor": ToolCursor,
		"start_session": ToolCursor, "clipboard_read": ToolDenied, "browser_prepare": ToolDenied,
		"set_config": ToolDenied, "start_recording": ToolDenied, "kill_app": ToolDenied, "install_extension": ToolDenied,
		"": ToolDenied,
	}
	for tool, want := range cases {
		if got := KindOf(tool); got != want {
			t.Fatalf("%s: kind %v, want %v", tool, got, want)
		}
	}
	seen := map[string]bool{}
	for _, tool := range AllowedTools() {
		if seen[tool] {
			t.Fatalf("%s listed twice", tool)
		}
		seen[tool] = true
		if KindOf(tool) == ToolDenied {
			t.Fatalf("%s allowed but denied", tool)
		}
	}
}

// inMemoryDriver serves a few tools over an in-memory MCP transport so the
// client's parsing is tested against the real protocol library.
func inMemoryDriver(t *testing.T) *Client {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "fake-driver", Version: "0"}, nil)
	server.AddTool(&mcp.Tool{Name: "get_desktop_state", InputSchema: map[string]any{"type": "object"}}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content:           []mcp.Content{&mcp.ImageContent{MIMEType: "image/png", Data: []byte("PNG!")}, &mcp.TextContent{Text: "desktop screenshot 10x5 px"}},
			StructuredContent: map[string]any{"screenshot_width": 10, "screenshot_height": 5, "screen_width": 20, "screen_height": 10, "scale_factor": 2.0, "capture_id": "cap_1"},
		}, nil
	})
	server.AddTool(&mcp.Tool{Name: "check_permissions", InputSchema: map[string]any{"type": "object"}}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}, StructuredContent: map[string]any{"accessibility": true, "screen_recording": false}}, nil
	})
	server.AddTool(&mcp.Tool{Name: "click", InputSchema: map[string]any{"type": "object"}}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "Accessibility: not granted"}}}, nil
	})
	c := NewClient("", "")
	c.transport = func() mcp.Transport {
		ct, st := mcp.NewInMemoryTransports()
		go func() { _, _ = server.Connect(context.Background(), st, nil) }()
		return ct
	}
	t.Cleanup(c.Close)
	return c
}

func TestClientParsesImagesStructuredContentAndRefusals(t *testing.T) {
	c := inMemoryDriver(t)
	ctx := context.Background()
	shot, err := CaptureDesktop(ctx, c, 1280)
	if err != nil {
		t.Fatal(err)
	}
	if string(shot.PNG) != "PNG!" || shot.Width != 10 || shot.ScreenW != 20 || shot.ScaleFactor != 2 || shot.CaptureID != "cap_1" {
		t.Fatalf("screenshot = %+v", shot)
	}
	p, err := CheckPermissions(ctx, c)
	if err != nil || !p.Accessibility || p.ScreenRecording {
		t.Fatalf("permissions = %+v err %v", p, err)
	}
	res, err := c.Call(ctx, "click", map[string]any{"pid": 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := res.Err(); err == nil || !strings.Contains(err.Error(), "not granted") {
		t.Fatalf("refusal not surfaced: %v", err)
	}
	if err := StartSession(ctx, c, "ops"); err == nil {
		t.Fatal("an unknown tool succeeded")
	}
}
