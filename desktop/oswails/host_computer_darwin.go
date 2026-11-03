//go:build desktop && darwin && cgo

package main

/*
#cgo LDFLAGS: -framework ApplicationServices
#include <stdlib.h>
char *GawkFrontmostApp(void);
int GawkAccessibilityTrusted(void);
int GawkScreenCaptureGranted(void);
void GawkRequestAccessibility(void);
void GawkRequestScreenCapture(void);
*/
import "C"

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/nex-crm/wuphf/internal/hostcomputer"
	"github.com/nex-crm/wuphf/internal/team"
)

// The person's own Mac as a computer for the office (internal/hostcomputer).
//
// The driver daemon must be a child of THIS process: macOS attributes
// Accessibility and Screen Recording to the app that spawned it, which is
// how the daemon inherits the grants the person gave gawkbot and never
// prompts on its own. So the shell starts it, not the broker, and only when
// the broker runs in-process; attached to an office served by the CLI, the
// grants would belong to the wrong process, and the notch says so instead.

// hostBundleID is the app's identifier, echoed in the driver's reports.
const hostBundleID = "ai.nex.wuphf.desktop"

// driverStartTimeout bounds the wait for the daemon's socket at launch.
var driverStartTimeout = 20 * time.Second

type macHost struct {
	daemon  *hostcomputer.Daemon
	client  *hostcomputer.Client
	watcher *hostcomputer.Watcher
	// attachedTo is the office this app attached to, when not its own.
	attachedTo string

	mu      sync.Mutex
	problem string
}

// driverBinary finds the bundled helper, or a developer's own driver via
// WUPHF_CUA_DRIVER for builds that were not packaged.
func driverBinary() (string, error) {
	if p := strings.TrimSpace(os.Getenv("WUPHF_CUA_DRIVER")); p != "" {
		return p, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	// gawkbot.app/Contents/MacOS/gawkbot -> gawkbot.app/Contents/Helpers/cua-driver
	helper := filepath.Join(filepath.Dir(filepath.Dir(exe)), "Helpers", hostcomputer.HelperName)
	if _, err := os.Stat(helper); err != nil {
		return "", fmt.Errorf("the computer-use driver is not in this build (%s)", helper)
	}
	return helper, nil
}

// driverHome is where the driver keeps its own state: themes, its
// telemetry choice. Never the office.
func driverHome() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "gawkbot", "cua-driver")
}

// newMacHost launches the daemon. A missing or failing driver is
// reported, not fatal: the office works without hands on the Mac.
func newMacHost(log io.Writer) *macHost {
	h := &macHost{}
	binary, err := driverBinary()
	if err != nil {
		h.setProblem(err.Error())
		fmt.Fprintln(log, "host computer:", err)
		return h
	}
	socket := hostcomputer.SocketPath()
	h.daemon = &hostcomputer.Daemon{
		Binary:       binary,
		Socket:       socket,
		HostBundleID: hostBundleID,
		Home:         driverHome(),
		Overlay:      true,
		Stderr:       log,
	}
	h.client = hostcomputer.NewClient(binary, socket)
	h.watcher = hostcomputer.NewWatcher(h.client)
	h.watcher.ReadURL = true
	h.watcher.Frontmost = frontmostApp
	ctx, cancel := context.WithTimeout(context.Background(), driverStartTimeout)
	defer cancel()
	if err := h.daemon.Start(ctx); err != nil {
		h.setProblem(err.Error())
		fmt.Fprintln(log, "host computer:", err)
	}
	return h
}

// startHostComputer is the in-process case: the office is ours, so the
// host is installed on the broker directly.
func startHostComputer(broker *team.Broker, log io.Writer) *macHost {
	if broker == nil {
		return nil
	}
	h := newMacHost(log)
	broker.SetHostComputer(h)
	return h
}

// attachHostComputer is the attached case: an office another process
// serves (the CLI's). The driver is still ours to spawn, since the grants
// are this app's, and the running broker is told where its socket is,
// through the web proxy, which signs loopback callers as the owner. The
// embedding contract allows exactly this split: the host spawns the
// daemon, another process connects a proxy to the host-owned socket.
func attachHostComputer(officeURL string, log io.Writer) *macHost {
	h := newMacHost(log)
	if h.daemon == nil || !h.daemon.Running() {
		return h
	}
	body, err := json.Marshal(map[string]string{"binary": h.daemon.Binary, "socket": h.daemon.Socket, "bundle_id": hostBundleID})
	if err != nil {
		h.setProblem(err.Error())
		return h
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, attachURL(officeURL), bytes.NewReader(body))
	if err != nil {
		h.setProblem(err.Error())
		return h
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		h.setProblem("could not tell the office about the driver: " + err.Error())
		fmt.Fprintln(log, "host computer:", h.problemText(""))
		return h
	}
	_ = res.Body.Close()
	if res.StatusCode/100 != 2 {
		h.setProblem(fmt.Sprintf("the office refused the driver (%d)", res.StatusCode))
		fmt.Fprintln(log, "host computer:", h.problemText(""))
		return h
	}
	h.attachedTo = officeURL
	fmt.Fprintln(log, "host computer: attached the driver to the office at", officeURL)
	return h
}

func attachURL(officeURL string) string {
	return strings.TrimRight(officeURL, "/") + "/api/host-computer/attach"
}

// detach tells the office the driver is going away with the app.
func (h *macHost) detach() {
	if h == nil || h.attachedTo == "" {
		return
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete, attachURL(h.attachedTo), nil)
	if err != nil {
		return
	}
	if res, err := (&http.Client{Timeout: 3 * time.Second}).Do(req); err == nil {
		_ = res.Body.Close()
	}
}

func (h *macHost) setProblem(p string) {
	h.mu.Lock()
	h.problem = p
	h.mu.Unlock()
}

// Driver is the live client while the daemon runs.
func (h *macHost) Driver() hostcomputer.Caller {
	if h == nil || h.daemon == nil || !h.daemon.Running() {
		return nil
	}
	return h.client
}

// DriverPath is the bundled driver and its socket, for a bot's bridge.
func (h *macHost) DriverPath() (string, string, bool) {
	if h == nil || h.daemon == nil || !h.daemon.Running() {
		return "", "", false
	}
	return h.daemon.Binary, h.daemon.Socket, true
}

// Screen is the frontmost-app watcher.
func (h *macHost) Screen() *hostcomputer.Watcher {
	if h == nil || h.watcher == nil {
		// A host with no driver still answers, with nothing to watch.
		return hostcomputer.NewWatcher(noDriver{})
	}
	return h.watcher
}

// Status says whether the daemon is up.
func (h *macHost) Status() team.HostComputerStatus {
	if h == nil || h.daemon == nil {
		return team.HostComputerStatus{Problem: h.problemText("the computer-use driver is not in this build")}
	}
	if !h.daemon.Running() {
		msg := "the computer-use driver is not running"
		if err := h.daemon.ExitError(); err != nil {
			msg += ": " + err.Error()
		}
		return team.HostComputerStatus{Problem: h.problemText(msg)}
	}
	return team.HostComputerStatus{Ready: true}
}

func (h *macHost) problemText(fallback string) string {
	if h == nil {
		return fallback
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.problem != "" {
		return h.problem
	}
	return fallback
}

// RequestPermission shows the macOS prompt. The driver reports what the
// app holds; only the app can ask.
func (h *macHost) RequestPermission(kind string) error {
	switch kind {
	case "accessibility":
		C.GawkRequestAccessibility()
	case "screen_recording":
		C.GawkRequestScreenCapture()
	default:
		return errors.New("unknown permission")
	}
	return nil
}

// Stop ends the daemon with the app.
func (h *macHost) Stop() {
	if h == nil {
		return
	}
	h.detach()
	if h.client != nil {
		h.client.Close()
	}
	if h.daemon != nil {
		h.daemon.Stop()
	}
}

// frontmostApp asks the workspace which app is in front. Exact and free of
// any permission, unlike the driver's own flag.
func frontmostApp() (hostcomputer.App, bool) {
	line := C.GawkFrontmostApp()
	defer C.free(unsafe.Pointer(line))
	parts := strings.SplitN(C.GoString(line), "\t", 3)
	if len(parts) != 3 {
		return hostcomputer.App{}, false
	}
	pid, err := strconv.Atoi(parts[0])
	if err != nil || pid <= 0 {
		return hostcomputer.App{}, false
	}
	return hostcomputer.App{PID: pid, BundleID: parts[1], Name: parts[2], Running: true}, true
}

// noDriver answers every call with a refusal, for a host without a driver.
type noDriver struct{}

func (noDriver) Call(context.Context, string, map[string]any) (hostcomputer.Result, error) {
	return hostcomputer.Result{Text: "the computer-use driver is not running", IsError: true}, nil
}
