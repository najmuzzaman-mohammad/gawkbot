package team

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type recordingController struct{ cancelled []string }

func (c *recordingController) CancelHeadlessTurns(slug string) {
	c.cancelled = append(c.cancelled, slug)
}

func TestNotchStopEndsOneBotWithoutPausingTheOffice(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	ctl := &recordingController{}
	b.SetHeadlessDispatchController(ctl)
	post := func(token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/notch/stop", strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchStop(rec, req)
		return rec
	}
	if rec := post("", `{"slug":"ops"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("a joined human stopped a bot: %d", rec.Code)
	}
	if rec := post("owner-token", `{"slug":"  "}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("no slug: %d", rec.Code)
	}
	if rec := post("owner-token", `{"slug":"ops"}`); rec.Code != http.StatusOK {
		t.Fatalf("stop: %d %s", rec.Code, rec.Body.String())
	}
	if len(ctl.cancelled) != 1 || ctl.cancelled[0] != "ops" {
		t.Fatalf("cancelled %v, want just ops", ctl.cancelled)
	}
	if b.GovernorStatus().Paused {
		t.Fatal("stopping one bot paused the whole office")
	}
}
