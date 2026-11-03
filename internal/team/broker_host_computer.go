package team

// broker_host_computer.go is the broker side of the person's own Mac as a
// surface for the notch: what is in front of them (only while the notch is
// open and only for the owner), which macOS permissions gawkbot holds, and
// what the notch can therefore offer. The desktop shell installs the
// HostComputer; a broker started from the CLI has none and every field
// here simply stays empty.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/internal/hostcomputer"
)

// HostComputer is the desktop app's embedded driver and the prompts only
// the app itself may show.
type HostComputer interface {
	// Driver is the live client, or nil while the daemon is down.
	Driver() hostcomputer.Caller
	// Screen is the frontmost-app watcher.
	Screen() *hostcomputer.Watcher
	// RequestPermission shows the macOS prompt for "accessibility" or
	// "screen_recording". The driver never prompts; the app must.
	RequestPermission(kind string) error
	// Status says whether the daemon is up, and why not.
	Status() HostComputerStatus
	// DriverPath is the driver binary and its socket, for a bot's bridge.
	DriverPath() (binary, socket string, ok bool)
}

// HostComputerStatus is the daemon's health in one line.
type HostComputerStatus struct {
	Ready   bool   `json:"ready"`
	Problem string `json:"problem,omitempty"`
}

// notchScreen is what the person has in front of them, for the notch.
type notchScreen struct {
	App         string `json:"app"`
	BundleID    string `json:"bundle_id,omitempty"`
	WindowTitle string `json:"window_title,omitempty"`
	URL         string `json:"url,omitempty"`
	Domain      string `json:"domain,omitempty"`
}

// notchPermissions is which macOS grants gawkbot holds right now.
type notchPermissions struct {
	Accessibility   bool `json:"accessibility"`
	ScreenRecording bool `json:"screen_recording"`
}

// notchCapabilities tells the notch which features it may offer, so a tool
// that cannot work is never shown or handed to a model.
type notchCapabilities struct {
	VoiceRealtime bool `json:"voice_realtime"`
	ScreenContext bool `json:"screen_context"`
	ScreenCapture bool `json:"screen_capture"`
	Pointer       bool `json:"pointer"`
	MacComputer   bool `json:"mac_computer"`
}

// notchScreenLease is how long one "the notch is open" poll keeps the
// screen watcher running. The notch polls every two seconds while open; a
// page that died stops renewing and the watcher stops with it.
var notchScreenLease = 6 * time.Second

// notchPermissionsTTL bounds how often the daemon is asked about grants.
var notchPermissionsTTL = 5 * time.Second

// notchCaptureMaxDim is the long edge of a screen picture handed to a
// model: enough to read a window, small enough to send on a key press.
const notchCaptureMaxDim = 1600

type hostComputerState struct {
	mu        sync.Mutex
	hc        HostComputer
	openUntil time.Time
	watching  bool
	perms     hostcomputer.Permissions
	permsAt   time.Time
	// scene is the drawing waiting for the notch page; sceneSeq changes
	// with every set or clear so the page draws each one once.
	scene    *hostcomputer.Scene
	sceneSeq int
}

// SetHostComputer installs (or, with nil, removes) the person's Mac.
func (b *Broker) SetHostComputer(hc HostComputer) {
	b.hostComputer.mu.Lock()
	defer b.hostComputer.mu.Unlock()
	if b.hostComputer.watching && b.hostComputer.hc != nil {
		b.hostComputer.hc.Screen().SetActive(false)
		b.hostComputer.watching = false
	}
	b.hostComputer.hc = hc
	b.hostComputer.permsAt = time.Time{}
}

func (b *Broker) hostComputerInstalled() HostComputer {
	b.hostComputer.mu.Lock()
	defer b.hostComputer.mu.Unlock()
	return b.hostComputer.hc
}

// noteNotchOpen renews the screen lease on an owner poll that says the
// notch is open, starting the watcher on the first one and arming the
// expiry that stops it once the polls stop.
func (b *Broker) noteNotchOpen(now time.Time) {
	h := &b.hostComputer
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.hc == nil {
		return
	}
	h.openUntil = now.Add(notchScreenLease)
	if !h.watching {
		h.watching = true
		h.hc.Screen().SetActive(true)
		time.AfterFunc(notchScreenLease, b.expireNotchScreen)
	}
}

func (b *Broker) expireNotchScreen() {
	h := &b.hostComputer
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.watching {
		return
	}
	if remaining := time.Until(h.openUntil); remaining > 0 {
		time.AfterFunc(remaining, b.expireNotchScreen)
		return
	}
	h.watching = false
	if h.hc != nil {
		h.hc.Screen().SetActive(false)
	}
}

// hostPermissions reads the grants, cached briefly: the notch polls often
// and a permission does not change between two polls.
func (b *Broker) hostPermissions(ctx context.Context, now time.Time) (hostcomputer.Permissions, bool) {
	h := &b.hostComputer
	h.mu.Lock()
	hc := h.hc
	if hc != nil && now.Sub(h.permsAt) < notchPermissionsTTL {
		p := h.perms
		h.mu.Unlock()
		return p, true
	}
	h.mu.Unlock()
	if hc == nil {
		return hostcomputer.Permissions{}, false
	}
	driver := hc.Driver()
	if driver == nil {
		return hostcomputer.Permissions{}, false
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	p, err := hostcomputer.CheckPermissions(ctx, driver)
	if err != nil {
		return hostcomputer.Permissions{}, false
	}
	h.mu.Lock()
	h.perms, h.permsAt = p, now
	h.mu.Unlock()
	return p, true
}

// withNotchHost adds the screen, permissions and capabilities. Only the
// owner's own surfaces get any of it; a joined human sees the office alone.
func (b *Broker) withNotchHost(ctx context.Context, state notchState, owner bool, now time.Time, open bool) notchState {
	if !owner {
		return state
	}
	caps := &notchCapabilities{VoiceRealtime: strings.TrimSpace(config.ResolveOpenAIAPIKey()) != ""}
	state.Capabilities = caps
	hc := b.hostComputerInstalled()
	if hc == nil {
		return state
	}
	state.Overlay = b.pendingOverlay()
	status := hc.Status()
	if !status.Ready {
		return state
	}
	perms, ok := b.hostPermissions(ctx, now)
	if ok {
		state.Permissions = &notchPermissions{Accessibility: perms.Accessibility, ScreenRecording: perms.ScreenRecording}
	}
	caps.ScreenContext = true
	caps.ScreenCapture = perms.ScreenRecording
	caps.Pointer = perms.Accessibility
	caps.MacComputer = perms.Accessibility && perms.ScreenRecording
	if !open {
		return state
	}
	b.noteNotchOpen(now)
	if sc, ok := hc.Screen().Snapshot(); ok && sc.App != "" {
		state.Screen = &notchScreen{App: sc.App, BundleID: sc.BundleID, WindowTitle: sc.WindowTitle, URL: sc.URL, Domain: sc.Domain}
	}
	return state
}

// notchCapture is POST /notch/screen/capture: one picture of the display,
// taken now because the person asked, never kept.
type notchCapture struct {
	DataURL     string       `json:"data_url"`
	Width       int          `json:"width"`
	Height      int          `json:"height"`
	ScreenW     int          `json:"screen_width"`
	ScreenH     int          `json:"screen_height"`
	ScaleFactor float64      `json:"scale_factor"`
	Screen      *notchScreen `json:"screen,omitempty"`
}

func (b *Broker) handleNotchScreenCapture(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner's notch may look at the screen"})
		return
	}
	hc := b.hostComputerInstalled()
	if hc == nil || !hc.Status().Ready {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "this office is not running inside the Mac app"})
		return
	}
	perms, _ := b.hostPermissions(r.Context(), time.Now())
	if !perms.ScreenRecording {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "gawkbot does not have Screen Recording permission yet", "permission": "screen_recording"})
		return
	}
	driver := hc.Driver()
	if driver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "the computer-use driver is not running"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	shot, err := hostcomputer.CaptureDesktop(ctx, driver, notchCaptureMaxDim)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	out := notchCapture{
		DataURL:     "data:image/png;base64," + base64.StdEncoding.EncodeToString(shot.PNG),
		Width:       shot.Width,
		Height:      shot.Height,
		ScreenW:     shot.ScreenW,
		ScreenH:     shot.ScreenH,
		ScaleFactor: shot.ScaleFactor,
	}
	if sc, err := hc.Screen().Refresh(ctx); err == nil && sc.App != "" {
		out.Screen = &notchScreen{App: sc.App, BundleID: sc.BundleID, WindowTitle: sc.WindowTitle, URL: sc.URL, Domain: sc.Domain}
	}
	writeJSON(w, http.StatusOK, out)
}

// permissionKinds are the grants the app can ask macOS for on request.
var permissionKinds = map[string]bool{"accessibility": true, "screen_recording": true}

func (b *Broker) handleNotchPermissionRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner may ask for permissions"})
		return
	}
	var body struct {
		Kind string `json:"kind"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	kind := strings.TrimSpace(body.Kind)
	if !permissionKinds[kind] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown permission"})
		return
	}
	hc := b.hostComputerInstalled()
	if hc == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "this office is not running inside the Mac app"})
		return
	}
	if err := hc.RequestPermission(kind); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	b.hostComputer.mu.Lock()
	b.hostComputer.permsAt = time.Time{}
	b.hostComputer.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "kind": kind})
}
