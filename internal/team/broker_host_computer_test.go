package team

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/hostcomputer"
)

// fakeMacDriver answers the driver tools the notch reads.
type fakeMacDriver struct {
	mu       sync.Mutex
	perms    hostcomputer.Permissions
	front    string
	calls    []string
	picture  []byte
	elements []hostcomputer.Element
}

func (f *fakeMacDriver) Call(_ context.Context, tool string, _ map[string]any) (hostcomputer.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, tool)
	raw := func(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
	switch tool {
	case "check_permissions":
		return hostcomputer.Result{Structured: raw(f.perms)}, nil
	case "list_apps":
		return hostcomputer.Result{Structured: raw(map[string]any{"apps": []map[string]any{
			{"name": f.front, "bundle_id": "com.google.Chrome", "pid": 42, "running": true, "active": true},
		}})}, nil
	case "list_windows":
		return hostcomputer.Result{Structured: raw(map[string]any{"windows": []map[string]any{
			{"window_id": 7, "pid": 42, "app_name": f.front, "title": "PR #4097", "z_index": 3, "is_on_screen": true},
		}})}, nil
	case "get_window_state":
		return hostcomputer.Result{Structured: raw(map[string]any{"elements": f.elements})}, nil
	case "start_session", "move_cursor":
		return hostcomputer.Result{Text: "ok"}, nil
	case "get_desktop_state":
		if !f.perms.ScreenRecording {
			return hostcomputer.Result{Text: "Screen Recording: not granted", IsError: true}, nil
		}
		return hostcomputer.Result{Images: []hostcomputer.Image{{MIMEType: "image/png", Data: f.picture}},
			Structured: raw(map[string]any{"screenshot_width": 160, "screenshot_height": 100, "screen_width": 1470, "screen_height": 956, "scale_factor": 2.0})}, nil
	}
	return hostcomputer.Result{Text: "no such tool", IsError: true}, nil
}

func (f *fakeMacDriver) count(tool string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == tool {
			n++
		}
	}
	return n
}

type fakeMacHost struct {
	driver  *fakeMacDriver
	watcher *hostcomputer.Watcher
	ready   bool
	asked   []string
}

func (h *fakeMacHost) Driver() hostcomputer.Caller   { return h.driver }
func (h *fakeMacHost) Screen() *hostcomputer.Watcher { return h.watcher }
func (h *fakeMacHost) RequestPermission(kind string) error {
	h.asked = append(h.asked, kind)
	return nil
}
func (h *fakeMacHost) DriverPath() (string, string, bool) {
	return "/usr/bin/true", "/tmp/gawkbot-cua-test.sock", h.ready
}
func (h *fakeMacHost) Status() HostComputerStatus {
	if !h.ready {
		return HostComputerStatus{Problem: "the driver is not running"}
	}
	return HostComputerStatus{Ready: true}
}

func newFakeMacHost(perms hostcomputer.Permissions) *fakeMacHost {
	d := &fakeMacDriver{perms: perms, front: "Google Chrome", picture: []byte("PNG")}
	return &fakeMacHost{driver: d, watcher: hostcomputer.NewWatcher(d), ready: true}
}

func notchStateAs(t *testing.T, b *Broker, token, query string) notchState {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/notch/state"+query, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	b.handleNotchState(rec, req)
	var s notchState
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestNotchStateCarriesTheScreenOnlyForTheOwnerWhileOpen(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	host := newFakeMacHost(hostcomputer.Permissions{Accessibility: true, ScreenRecording: true})
	b.SetHostComputer(host)

	// A joined human gets none of it, open or not.
	if s := notchStateAs(t, b, "", "?open=1"); s.Screen != nil || s.Permissions != nil || s.Capabilities != nil {
		t.Fatalf("a joined human saw the owner's screen: %+v", s)
	}
	// The owner, notch closed: capabilities and permissions, no screen, no watcher.
	s := notchStateAs(t, b, "owner-token", "")
	if s.Screen != nil || s.Permissions == nil || !s.Permissions.Accessibility || s.Capabilities == nil || !s.Capabilities.ScreenContext || !s.Capabilities.ScreenCapture || !s.Capabilities.Pointer || !s.Capabilities.MacComputer {
		t.Fatalf("closed notch: %+v perms=%+v caps=%+v", s.Screen, s.Permissions, s.Capabilities)
	}
	if host.watcher.Active() {
		t.Fatal("the watcher ran while the notch was closed")
	}
	// Open: the watcher starts; once it has read, the poll carries what is
	// in front. The read is forced here rather than awaited from the loop.
	notchStateAs(t, b, "owner-token", "?open=1")
	if !host.watcher.Active() {
		t.Fatal("the watcher did not start on an open poll")
	}
	if _, err := host.watcher.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := notchStateAs(t, b, "owner-token", "?open=1")
	if got.Screen == nil || got.Screen.App != "Google Chrome" || got.Screen.WindowTitle != "PR #4097" {
		t.Fatalf("screen = %+v", got.Screen)
	}
	// Polls stop (the page went away): once the lease is in the past, the
	// expiry stops the watcher. The clock is moved by hand, not waited on.
	b.hostComputer.mu.Lock()
	b.hostComputer.openUntil = time.Now().Add(-time.Second)
	b.hostComputer.mu.Unlock()
	b.expireNotchScreen()
	if host.watcher.Active() {
		t.Fatal("the watcher kept running after the lease lapsed")
	}
	if _, ok := host.watcher.Snapshot(); ok {
		t.Fatal("a screen reading survived the notch closing")
	}
	// Permissions are cached between polls.
	n := host.driver.count("check_permissions")
	notchStateAs(t, b, "owner-token", "")
	if host.driver.count("check_permissions") != n {
		t.Fatal("permissions re-read within the cache window")
	}
}

func TestNotchStateWithoutAMacAppOrADaemon(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	s := notchStateAs(t, b, "owner-token", "?open=1")
	if s.Capabilities == nil || s.Capabilities.ScreenContext || s.Permissions != nil || s.Screen != nil {
		t.Fatalf("no host: %+v %+v %+v", s.Capabilities, s.Permissions, s.Screen)
	}
	host := newFakeMacHost(hostcomputer.Permissions{})
	host.ready = false
	b.SetHostComputer(host)
	s = notchStateAs(t, b, "owner-token", "?open=1")
	if s.Capabilities.ScreenContext || host.watcher.Active() {
		t.Fatal("a down daemon offered the screen")
	}
}

func TestNotchScreenCaptureNeedsTheOwnerAndScreenRecording(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	host := newFakeMacHost(hostcomputer.Permissions{Accessibility: true})
	b.SetHostComputer(host)
	post := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/notch/screen/capture", strings.NewReader("{}"))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchScreenCapture(rec, req)
		return rec
	}
	if rec := post(""); rec.Code != http.StatusForbidden {
		t.Fatalf("joined human got %d", rec.Code)
	}
	rec := post("owner-token")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "screen_recording") {
		t.Fatalf("without Screen Recording: %d %s", rec.Code, rec.Body.String())
	}
	host.driver.perms.ScreenRecording = true
	b.hostComputer.permsAt = time.Time{}
	rec = post("owner-token")
	if rec.Code != http.StatusOK {
		t.Fatalf("capture: %d %s", rec.Code, rec.Body.String())
	}
	var out notchCapture
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.DataURL, "data:image/png;base64,") || out.ScreenW != 1470 || out.ScaleFactor != 2 || out.Screen == nil || out.Screen.App != "Google Chrome" {
		t.Fatalf("capture = %+v", out)
	}
}

func TestNotchPermissionRequestGoesToTheApp(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	host := newFakeMacHost(hostcomputer.Permissions{})
	b.SetHostComputer(host)
	post := func(token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/notch/permissions/request", strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchPermissionRequest(rec, req)
		return rec
	}
	if rec := post("", `{"kind":"accessibility"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("joined human got %d", rec.Code)
	}
	if rec := post("owner-token", `{"kind":"camera"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown kind got %d", rec.Code)
	}
	if rec := post("owner-token", `{"kind":"screen_recording"}`); rec.Code != http.StatusOK {
		t.Fatalf("request got %d %s", rec.Code, rec.Body.String())
	}
	if len(host.asked) != 1 || host.asked[0] != "screen_recording" {
		t.Fatalf("asked = %v", host.asked)
	}
}

func TestNotchStateAsksForGrantsOnlyWhenABotRunsOnThisMac(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	b.SetHostComputer(newFakeMacHost(hostcomputer.Permissions{}))
	if s := notchStateAs(t, b, "owner-token", "?open=1"); s.HostWanted {
		t.Fatal("no bot runs on this Mac, yet the notch wants grants")
	}
	b.mu.Lock()
	b.members = append(b.members, officeMember{Slug: "ops", Name: "Ops", Computer: computerMac})
	b.mu.Unlock()
	if s := notchStateAs(t, b, "owner-token", "?open=1"); !s.HostWanted {
		t.Fatal("a bot on this Mac did not make the notch ask for grants")
	}
	if s := notchStateAs(t, b, "", "?open=1"); s.HostWanted {
		t.Fatal("a joined human was asked for the owner's grants")
	}
}
