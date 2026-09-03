package box

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBoxAPI is a minimal ascii.dev stand-in: boxes are created, named,
// listed, resumed, and answer commands with scripted output.
type fakeBoxAPI struct {
	mu       sync.Mutex
	boxes    map[string]map[string]any
	commands []string
	nextID   int
	cmdOut   func(command string) (int, string, string)
	fileData []byte
}

func newFakeBoxAPI() *fakeBoxAPI {
	return &fakeBoxAPI{boxes: map[string]map[string]any{}, cmdOut: func(string) (int, string, string) { return 0, "bootstrapped\n", "" }}
}

func (f *fakeBoxAPI) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer box_test" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"message": "bad token"})
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		path := strings.TrimPrefix(r.URL.Path, "/")
		parts := strings.Split(path, "/")
		switch {
		case r.Method == http.MethodGet && path == "boxes":
			list := []any{}
			for _, b := range f.boxes {
				list = append(list, b)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "boxes": list})
		case r.Method == http.MethodPost && path == "boxes":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["noEnv"] != true {
				t.Errorf("create must set noEnv")
			}
			f.nextID++
			id := "box-" + string(rune('a'+f.nextID))
			f.boxes[id] = map[string]any{"id": id, "name": "", "state": "starting"}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "box": f.boxes[id]})
		case len(parts) == 2 && parts[0] == "boxes" && r.Method == http.MethodGet:
			b, ok := f.boxes[parts[1]]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if b["state"] == "starting" {
				b["state"] = "running"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "box": b})
		case len(parts) == 2 && parts[0] == "boxes" && r.Method == http.MethodPatch:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.boxes[parts[1]]["name"] = body["name"]
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "box": f.boxes[parts[1]]})
		case len(parts) == 3 && parts[2] == "commands":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			cmd, _ := body["command"].(string)
			f.commands = append(f.commands, cmd)
			if f.boxes[parts[1]]["state"] == "archived" {
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": "machine_not_running"})
				return
			}
			code, out, errOut := f.cmdOut(cmd)
			_ = json.NewEncoder(w).Encode(map[string]any{"exitCode": code, "stdout": out, "stderr": errOut})
		case len(parts) == 3 && parts[2] == "stop":
			f.boxes[parts[1]]["state"] = "archived"
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		case len(parts) == 3 && parts[2] == "resume":
			f.boxes[parts[1]]["state"] = "running"
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		case len(parts) == 3 && parts[2] == "desktop":
			_ = json.NewEncoder(w).Encode(map[string]any{"desktopUrl": "https://desktop.example/" + parts[1] + "?t=" + time.Now().Format("150405.000")})
		case len(parts) == 3 && parts[2] == "artifacts":
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(f.fileData)
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"message": "no route " + r.URL.Path})
		}
	})
}

func TestNameForIsStableAndSafe(t *testing.T) {
	a, b := NameFor("chief-of-staff"), NameFor("chief-of-staff")
	if a != b || !strings.HasPrefix(a, "gb-chiefofs-") || len(a) != len("gb-chiefofs-")+6 {
		t.Fatalf("unexpected name %q", a)
	}
	if NameFor("Chief!") == NameFor("chief") {
		t.Fatalf("names must differ for different slugs")
	}
}

func TestProvisionCreatesNamesBootstrapsAndReuses(t *testing.T) {
	api := newFakeBoxAPI()
	srv := httptest.NewServer(api.handler(t))
	defer srv.Close()
	c := NewClient("box_test")
	c.API = srv.URL
	ctx := context.Background()
	res, err := c.Provision(ctx, "cos", "Chief of Staff")
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if res.Reused || res.MachineName != NameFor("cos") || !strings.HasPrefix(res.JoinURL, "https://desktop.example/") {
		t.Fatalf("unexpected provision result %+v", res)
	}
	if api.boxes[res.BoxID]["name"] != NameFor("cos") {
		t.Fatalf("box must be renamed to the deterministic name")
	}
	boot := strings.Join(api.commands, "\n")
	if !strings.Contains(boot, remoteWheels["x86_64"].SHA256) || !strings.Contains(boot, "sha256sum -c -") || !strings.Contains(boot, RemoteCuaExecutable) {
		t.Fatalf("bootstrap must install the pinned driver, got %s", boot)
	}
	if strings.Contains(boot, "Chief of Staff") {
		t.Fatalf("display name must reach the box only base64-encoded")
	}
	again, err := c.Provision(ctx, "cos", "Chief of Staff")
	if err != nil || !again.Reused || again.BoxID != res.BoxID {
		t.Fatalf("second provision must reuse: %+v %v", again, err)
	}
}

func TestRunWakesArchivedBoxViaProxyPath(t *testing.T) {
	api := newFakeBoxAPI()
	srv := httptest.NewServer(api.handler(t))
	defer srv.Close()
	c := NewClient("box_test")
	c.API = srv.URL
	ctx := context.Background()
	res, err := c.Provision(ctx, "cos", "CoS")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Sleep(ctx, "cos"); err != nil {
		t.Fatal(err)
	}
	if api.boxes[res.BoxID]["state"] != "archived" {
		t.Fatalf("sleep must archive")
	}
	_, err = c.Run(ctx, res.BoxID, "echo hi", 5*time.Second)
	var nr *NotRunningError
	if !asNotRunning(err, &nr) {
		t.Fatalf("archived box must answer NotRunningError, got %v", err)
	}
	p := &Proxy{client: c, boxID: res.BoxID}
	out, err := p.run(ctx, "echo hi", 5*time.Second)
	if err != nil || !out.OK {
		t.Fatalf("proxy run must wake the box and retry: %v %+v", err, out)
	}
	if api.boxes[res.BoxID]["state"] != "running" {
		t.Fatalf("box must be running after wake")
	}
	last := api.commands[len(api.commands)-1]
	if !strings.HasPrefix(last, "exec env -i") || !strings.Contains(last, "'echo hi'") {
		t.Fatalf("bot commands must run in the isolated env: %s", last)
	}
}

func TestScreenshotReadsFrameOverHTTP(t *testing.T) {
	api := newFakeBoxAPI()
	jpeg := append([]byte{0xff, 0xd8}, make([]byte, 600)...)
	jpeg = append(jpeg, 0xff, 0xd9)
	api.fileData = jpeg
	api.cmdOut = func(cmd string) (int, string, string) {
		if strings.Contains(cmd, "captured") {
			return 0, "captured\n", ""
		}
		return 0, "bootstrapped\n", ""
	}
	srv := httptest.NewServer(api.handler(t))
	defer srv.Close()
	c := NewClient("box_test")
	c.API = srv.URL
	ctx := context.Background()
	res, err := c.Provision(ctx, "cos", "CoS")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := c.Screenshot(ctx, res.BoxID)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != string(jpeg) {
		t.Fatalf("frame bytes must round-trip")
	}
}

func TestActionShellAndFrameParsing(t *testing.T) {
	shell, err := actionShell(batchAction{Action: "click", X: 100, Y: 50, Button: "right"})
	if err != nil || !strings.Contains(shell, `"button":"right"`) || !strings.Contains(shell, "xdotool mousemove $CX $CY click 3") {
		t.Fatalf("unexpected click shell: %v %s", err, shell)
	}
	shell, err = actionShell(batchAction{Action: "press_key", Keys: "ctrl+l; rm -rf /"})
	if err != nil || strings.Contains(shell, "rm -rf") || strings.Contains(shell, "xdotool key ctrl+l;") || !strings.Contains(shell, "hotkey") {
		t.Fatalf("keys must be sanitized: %v %s", err, shell)
	}
	shell, err = actionShell(batchAction{Action: "type_text", Text: "it's \"quoted\""})
	if err != nil || !strings.Contains(shell, `'\''`) {
		t.Fatalf("text must be shell-quoted: %v %s", err, shell)
	}
	if _, err := actionShell(batchAction{Action: "format_disk"}); err == nil {
		t.Fatalf("unknown actions must be refused")
	}
	jpeg := append([]byte{0xff, 0xd8}, make([]byte, 600)...)
	jpeg = append(jpeg, 0xff, 0xd9)
	b64 := base64.StdEncoding.EncodeToString(jpeg)
	out := CommandResult{Stdout: "BACKEND CUA\nCAPTURE CUA\nGEOM 1280 800\nSIZE 604\nB64 " + b64 + "\nACT ok\n"}
	frame, geom := frameFrom(context.Background(), &Proxy{client: NewClient("box_test"), boxID: "x"}, out)
	if geom != "1280 800" || len(frame) != len(jpeg) {
		t.Fatalf("inline frame must be trusted when size matches: geom=%s len=%d", geom, len(frame))
	}
	truncated := CommandResult{Stdout: "GEOM 1280 800\nSIZE 9999\nB64 " + b64 + "\nACT ok\n"}
	c := NewClient("box_test")
	c.API = "http://127.0.0.1:1"
	c.HTTP = &http.Client{Timeout: 200 * time.Millisecond}
	frame, _ = frameFrom(context.Background(), &Proxy{client: c, boxID: "x"}, truncated)
	if frame != nil {
		t.Fatalf("a size mismatch must not become a trusted frame")
	}
}

func TestViewerLinkShapesOnlyNoVNC(t *testing.T) {
	raw := "https://x-6080.on.ascii.dev/vnc.html?autoconnect=true&resize=remote&path=websockify&password=pw&_token=t"
	view := ViewerLink(raw, true)
	for _, want := range []string{"view_only=true", "resize=scale", "show_dot=true", "password=pw", "_token=t", "path=websockify"} {
		if !strings.Contains(view, want) {
			t.Fatalf("view link missing %s: %s", want, view)
		}
	}
	if strings.Contains(view, "resize=remote") {
		t.Fatalf("view link must scale, not resize the remote: %s", view)
	}
	if !strings.Contains(ViewerLink(raw, false), "view_only=false") {
		t.Fatalf("control link must allow input")
	}
	stream := "https://x-desktop.on.ascii.dev/stream.html?hostId=1&width=1920#tok"
	if ViewerLink(stream, true) != stream {
		t.Fatalf("non-noVNC links pass through untouched")
	}
}

func TestErrorMessageAlwaysLinksBilling(t *testing.T) {
	msg := ErrorMessage(http.StatusPaymentRequired, "box create", map[string]any{"message": "Start the $20/month Box plan to create sandboxes."})
	if !strings.Contains(msg, "Start the $20/month Box plan") || !strings.Contains(msg, BillingURL) {
		t.Fatalf("402 must keep the provider's words and add the billing link: %s", msg)
	}
	if strings.Contains(ErrorMessage(http.StatusPaymentRequired, "box create", map[string]any{"error": map[string]any{"details": map[string]any{"billingUrl": "https://x/?box_token=secret"}}}), "box_token") {
		t.Fatalf("the provider's token-bearing link must never be surfaced")
	}
}
