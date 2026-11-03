package team

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/hostcomputer"
)

func TestNotchOverlayDrawsOnlyValidScenesForTheOwner(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	host := newFakeMacHost(hostcomputer.Permissions{Accessibility: true, ScreenRecording: true})
	b.SetHostComputer(host)
	do := func(method, token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/notch/overlay", strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchOverlay(rec, req)
		return rec
	}
	if rec := do(http.MethodPost, "", `{"items":[{"kind":"label","x":1,"y":2,"text":"hi"}]}`); rec.Code != http.StatusForbidden {
		t.Fatalf("joined human drew: %d", rec.Code)
	}
	if rec := do(http.MethodPost, "owner-token", `{"items":[{"kind":"laser","x":1,"y":2}]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown kind accepted: %d %s", rec.Code, rec.Body.String())
	}
	rec := do(http.MethodPost, "owner-token", `{"items":[{"kind":"label","x":10,"y":20,"text":"Move into folder"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("draw: %d %s", rec.Code, rec.Body.String())
	}
	s := notchStateAs(t, b, "owner-token", "")
	if s.Overlay == nil || s.Overlay.Seq != 1 || s.Overlay.Scene == nil || s.Overlay.Scene.Items[0].Text != "Move into folder" || s.Overlay.Scene.TTLMs == 0 {
		t.Fatalf("pending overlay = %+v", s.Overlay)
	}
	if rec := do(http.MethodDelete, "owner-token", ""); rec.Code != http.StatusOK {
		t.Fatalf("clear: %d", rec.Code)
	}
	if s := notchStateAs(t, b, "owner-token", ""); s.Overlay == nil || s.Overlay.Seq != 2 || s.Overlay.Scene != nil {
		t.Fatalf("after clear = %+v", s.Overlay)
	}
	if s := notchStateAs(t, b, "", ""); s.Overlay != nil {
		t.Fatal("a joined human saw the overlay")
	}
}

func TestNotchPointFindsTheControlInFrontAndLabelsIt(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	host := newFakeMacHost(hostcomputer.Permissions{Accessibility: true, ScreenRecording: true})
	host.driver.elements = []hostcomputer.Element{
		{Index: 3, Role: "AXButton", Label: "Cancel", Frame: hostcomputer.Rect{X: 500, Y: 400, W: 80, H: 28}},
		{Index: 4, Role: "AXButton", Label: "Merge pull request", Frame: hostcomputer.Rect{X: 600, Y: 400, W: 160, H: 28}},
	}
	b.SetHostComputer(host)
	post := func(body string) (*httptest.ResponseRecorder, notchPointResult) {
		req := httptest.NewRequest(http.MethodPost, "/notch/point", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer owner-token")
		rec := httptest.NewRecorder()
		b.handleNotchPoint(rec, req)
		var out notchPointResult
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}
	rec, out := post(`{"query":"merge","label":"blocked on CI","seconds":4}`)
	if rec.Code != http.StatusOK || !out.Found || out.Name != "Merge pull request" || out.Frame == nil {
		t.Fatalf("point: %d %s", rec.Code, rec.Body.String())
	}
	if out.Scene == nil || out.Scene.TTLMs != 4000 || out.Scene.Items[0].Label != "blocked on CI" || out.Scene.Items[1].Kind != "box" || out.Seq != 1 {
		t.Fatalf("scene = %+v seq=%d", out.Scene, out.Seq)
	}
	if host.driver.count("move_cursor") != 1 || host.driver.count("start_session") != 1 {
		t.Fatalf("guide cursor calls: %v", host.driver.calls)
	}
	if rec, out := post(`{"query":"nothing like this"}`); rec.Code != http.StatusOK || out.Found {
		t.Fatalf("missing control: %d %+v", rec.Code, out)
	}
	if rec, _ := post(`{"label":"here"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("no target accepted: %d", rec.Code)
	}
	host.driver.perms.Accessibility = false
	b.hostComputer.permsAt = time.Time{}
	if rec, _ := post(`{"query":"merge"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("without Accessibility: %d", rec.Code)
	}
	if rec, out := post(`{"x":12,"y":34,"label":"here"}`); rec.Code != http.StatusOK || !out.Found || out.X != 12 {
		t.Fatalf("raw point: %d %+v", rec.Code, out)
	}
}
