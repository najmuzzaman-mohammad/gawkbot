package team

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/hostcomputer"
)

func TestAttachedAppRegistersItsDriverSocket(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	socket := filepath.Join("/tmp", "gawkbot-cua-test-"+strings.ReplaceAll(t.Name(), "/", "-")[:6]+".sock")
	_ = os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Skip("no unix sockets here")
	}
	t.Cleanup(func() { _ = ln.Close(); _ = os.Remove(socket) })
	bin := filepath.Join(t.TempDir(), "cua-driver")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	do := func(method, token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/host-computer/attach", strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleHostComputerAttach(rec, req)
		return rec
	}
	if rec := do(http.MethodPost, "", `{"binary":"`+bin+`","socket":"`+socket+`"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("joined human attached: %d", rec.Code)
	}
	if rec := do(http.MethodPost, "owner-token", `{"binary":"`+bin+`","socket":"/etc/passwd"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad socket accepted: %d", rec.Code)
	}
	if rec := do(http.MethodPost, "owner-token", `{"binary":"`+bin+`","socket":"`+socket+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("attach: %d %s", rec.Code, rec.Body.String())
	}
	hc := b.hostComputerInstalled()
	if hc == nil || !hc.Status().Ready {
		t.Fatalf("remote host not ready: %+v", hc)
	}
	s := notchStateAs(t, b, "owner-token", "")
	if s.Capabilities == nil || !s.Capabilities.ScreenContext {
		t.Fatalf("capabilities after attach: %+v", s.Capabilities)
	}
	if err := hc.RequestPermission("accessibility"); err == nil {
		t.Fatal("a remote host claimed to prompt")
	}
	// The app's own office keeps its in-process host over a late attach.
	b.SetHostComputer(newFakeMacHost(hostcomputer.Permissions{}))
	if rec := do(http.MethodPost, "owner-token", `{"binary":"`+bin+`","socket":"`+socket+`"}`); rec.Code != http.StatusConflict {
		t.Fatalf("attach over an in-process host: %d", rec.Code)
	}
	b.SetHostComputer(newRemoteHost(bin, socket))
	if rec := do(http.MethodDelete, "owner-token", ""); rec.Code != http.StatusOK || b.hostComputerInstalled() != nil {
		t.Fatalf("detach: %d host=%v", rec.Code, b.hostComputerInstalled())
	}
}
