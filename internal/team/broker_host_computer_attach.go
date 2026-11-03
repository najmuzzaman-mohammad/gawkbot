package team

// broker_host_computer_attach.go: the Mac app attached to an office that
// another process serves (the CLI's `gawkbot`) still owns the driver, since
// macOS ties the grants to the app that spawns it. The app registers the
// daemon's socket here, and the broker reaches it through the driver's own
// proxy, as the embedding contract allows: the host spawns the daemon,
// gateways connect a proxy to the host-owned socket. Only the owner's
// token may attach, and only a socket under /tmp that exists.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/hostcomputer"
)

// hostAttachRequest is POST /host-computer/attach.
type hostAttachRequest struct {
	Binary   string `json:"binary"`
	Socket   string `json:"socket"`
	BundleID string `json:"bundle_id,omitempty"`
}

// remoteHost is a driver another process spawned: the app's daemon, reached
// over its socket. Prompts cannot be shown from here; the notch asks the
// app directly.
type remoteHost struct {
	binary  string
	socket  string
	client  *hostcomputer.Client
	watcher *hostcomputer.Watcher

	mu      sync.Mutex
	up      bool
	checked time.Time
}

// remoteHostStatusTTL bounds how often the socket is dialled for status.
var remoteHostStatusTTL = 2 * time.Second

func newRemoteHost(binary, socket string) *remoteHost {
	client := hostcomputer.NewClient(binary, socket)
	watcher := hostcomputer.NewWatcher(client)
	watcher.ReadURL = true
	watcher.Frontmost = hostcomputer.FrontmostFromLaunchServices
	return &remoteHost{binary: binary, socket: socket, client: client, watcher: watcher}
}

func (h *remoteHost) Driver() hostcomputer.Caller {
	if !h.Status().Ready {
		return nil
	}
	return h.client
}

func (h *remoteHost) Screen() *hostcomputer.Watcher { return h.watcher }

func (h *remoteHost) DriverPath() (string, string, bool) {
	return h.binary, h.socket, h.Status().Ready
}

func (h *remoteHost) RequestPermission(string) error {
	return errors.New("the Mac app shows permission prompts; ask through the notch")
}

func (h *remoteHost) Status() HostComputerStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	if time.Since(h.checked) < remoteHostStatusTTL {
		return h.statusLocked()
	}
	dialer := &net.Dialer{Timeout: 300 * time.Millisecond}
	conn, err := dialer.DialContext(context.Background(), "unix", h.socket)
	h.up = err == nil
	if conn != nil {
		_ = conn.Close()
	}
	h.checked = time.Now()
	return h.statusLocked()
}

func (h *remoteHost) statusLocked() HostComputerStatus {
	if h.up {
		return HostComputerStatus{Ready: true}
	}
	return HostComputerStatus{Problem: "the Mac app's computer-use driver is not answering"}
}

func (h *remoteHost) close() {
	h.client.Close()
}

func validHostSocket(path string) bool {
	if !strings.HasPrefix(path, hostcomputer.SocketPrefix()) || strings.Contains(path, "..") {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && st.Mode()&os.ModeSocket != 0
}

func validHostBinary(path string) bool {
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0
}

func (b *Broker) handleHostComputerAttach(w http.ResponseWriter, r *http.Request) {
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner's app may attach a computer"})
		return
	}
	switch r.Method {
	case http.MethodDelete:
		b.detachRemoteHost()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case http.MethodPost:
		var req hostAttachRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
			return
		}
		if !validHostSocket(req.Socket) || !validHostBinary(req.Binary) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "the driver socket or binary is not acceptable"})
			return
		}
		// An office the app itself runs already has its host; the in-process
		// one wins because it can show prompts and draw.
		if hc := b.hostComputerInstalled(); hc != nil {
			if _, remote := hc.(*remoteHost); !remote {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "this office runs inside the Mac app already"})
				return
			}
		}
		b.detachRemoteHost()
		b.SetHostComputer(newRemoteHost(req.Binary, req.Socket))
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (b *Broker) detachRemoteHost() {
	hc := b.hostComputerInstalled()
	rh, ok := hc.(*remoteHost)
	if !ok {
		return
	}
	b.SetHostComputer(nil)
	rh.close()
}
