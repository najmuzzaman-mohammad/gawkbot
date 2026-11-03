package computer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// A bot on the person's Mac: only the policy's tools reach the driver,
// each call carries the bot's session, acting calls wait for consent and
// go to the background, and the bot never sees the bridge's own traffic.
func TestHostBridgeEnforcesPolicySessionConsentAndBackground(t *testing.T) {
	var mu sync.Mutex
	snap := Snapshot{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["action"] == "request-consent" {
				summary := "wants to click"
				snap.ConsentOpen, snap.ConsentSummary, snap.ConsentDecision = true, &summary, ""
				_ = json.NewEncoder(w).Encode(map[string]any{"request_id": "c1"})
				return
			}
		}
		_ = json.NewEncoder(w).Encode(snap)
	}))
	defer srv.Close()
	prev := helpPollInterval
	helpPollInterval = 5 * 1e6 // 5ms
	t.Cleanup(func() { helpPollInterval = prev })

	var forwarded, emitted []string
	g := &gateInterceptor{
		gate:    &GateClient{URL: srv.URL, Token: "tok", CacheMs: 1},
		host:    &HostPolicy{Slug: "ops", Label: "Ops", Color: "#ff8800"},
		forward: func(l string) { forwarded = append(forwarded, l) },
		emit:    func(l string) { emitted = append(emitted, l) },
		listIDs: map[string]bool{},
		ended:   make(chan struct{}),
	}
	ctx := context.Background()
	// initialize: the driver's answer is when the session is declared.
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	g.fromChild(`{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}`)
	if len(emitted) != 1 || len(forwarded) != 3 || !strings.Contains(forwarded[1], `"start_session"`) || !strings.Contains(forwarded[2], `"cursor_label":"Ops"`) || !strings.Contains(forwarded[2], `"cursor_color":"#ff8800"`) {
		t.Fatalf("after initialize: fwd=%v emit=%v", forwarded, emitted)
	}
	// The driver's answers to the bridge's own calls never reach the bot.
	g.fromChild(`{"jsonrpc":"2.0","id":"gawk:session","result":{"content":[]}}`)
	g.fromChild(`{"jsonrpc":"2.0","id":"gawk:cursor","result":{"content":[]}}`)
	if len(emitted) != 1 {
		t.Fatalf("bridge answers leaked to the bot: %v", emitted)
	}
	// A denied tool is refused on the near side.
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"clipboard_read","arguments":{}}}`)
	if len(forwarded) != 3 || !strings.Contains(emitted[len(emitted)-1], `"isError":true`) || !strings.Contains(emitted[len(emitted)-1], "clipboard_read") {
		t.Fatalf("denied tool: fwd=%d emit=%s", len(forwarded), emitted[len(emitted)-1])
	}
	// A read carries the session and needs no consent.
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_window_state","arguments":{"pid":7}}}`)
	if last := forwarded[len(forwarded)-1]; !strings.Contains(last, `"session":"ops"`) || strings.Contains(last, "delivery_mode") {
		t.Fatalf("read call: %s", last)
	}
	// The first action waits for the person; denied means refused.
	go func() {
		for {
			mu.Lock()
			open := snap.ConsentOpen
			mu.Unlock()
			if open {
				mu.Lock()
				snap.ConsentOpen, snap.ConsentDecision = false, ConsentDeny
				mu.Unlock()
				return
			}
		}
	}()
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"click","arguments":{"pid":7,"x":1,"y":2}}}`)
	if last := emitted[len(emitted)-1]; !strings.Contains(last, ConsentRefusal) {
		t.Fatalf("denied consent: %s", last)
	}
	// Once decided for the turn, it is not asked again.
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"type_text","arguments":{"pid":7,"text":"hi"}}}`)
	if last := emitted[len(emitted)-1]; !strings.Contains(last, ConsentRefusal) || len(forwarded) != 4 {
		t.Fatalf("second action after a no: %s fwd=%d", last, len(forwarded))
	}
	// tools/list is filtered to the policy, plus the help tool.
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":6,"method":"tools/list"}`)
	g.fromChild(`{"jsonrpc":"2.0","id":6,"result":{"tools":[{"name":"click"},{"name":"clipboard_read"},{"name":"set_config"},{"name":"move_cursor"}]}}`)
	last := emitted[len(emitted)-1]
	if strings.Contains(last, "clipboard_read") || strings.Contains(last, "set_config") || !strings.Contains(last, `"name":"click"`) || !strings.Contains(last, `"name":"move_cursor"`) || !strings.Contains(last, HelpToolName) {
		t.Fatalf("filtered list: %s", last)
	}
	// The end of the turn ends the session; the driver's answer releases the wait.
	ended := g.ended
	g.forward(g.sessionEnd())
	if !strings.Contains(forwarded[len(forwarded)-1], `"end_session"`) {
		t.Fatalf("end: %s", forwarded[len(forwarded)-1])
	}
	g.fromChild(`{"jsonrpc":"2.0","id":"gawk:end","result":{"content":[]}}`)
	select {
	case <-ended:
	default:
		t.Fatal("the end of the session was not signalled")
	}
	// What the bot saw: the initialize answer, three refusals, the filtered list.
	if len(emitted) != 5 {
		t.Fatalf("bridge traffic leaked to the bot: %d lines", len(emitted))
	}
}

func TestHostBridgeAlwaysDeliversInTheBackground(t *testing.T) {
	var forwarded, emitted []string
	g := &gateInterceptor{
		gate:    &GateClient{},
		host:    &HostPolicy{Slug: "ops", AlwaysAllow: true},
		forward: func(l string) { forwarded = append(forwarded, l) },
		emit:    func(l string) { emitted = append(emitted, l) },
		listIDs: map[string]bool{},
		ended:   make(chan struct{}),
	}
	ctx := context.Background()
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"click","arguments":{"pid":7,"element_index":3}}}`)
	if len(emitted) != 0 || len(forwarded) != 1 {
		t.Fatalf("allowed click: fwd=%v emit=%v", forwarded, emitted)
	}
	var frame struct {
		Params struct {
			Arguments map[string]any `json:"arguments"`
		} `json:"params"`
	}
	_ = json.Unmarshal([]byte(forwarded[0]), &frame)
	if frame.Params.Arguments["delivery_mode"] != "background" || frame.Params.Arguments["session"] != "ops" || frame.Params.Arguments["element_index"] != float64(3) {
		t.Fatalf("arguments = %v", frame.Params.Arguments)
	}
	// A bot that asks for the foreground does not get it: the real
	// pointer and focus stay the person's.
	g.fromBot(ctx, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"type_text","arguments":{"pid":7,"text":"x","delivery_mode":"foreground"}}}`)
	if !strings.Contains(forwarded[1], `"delivery_mode":"background"`) || strings.Contains(forwarded[1], "foreground") {
		t.Fatalf("foreground was let through: %s", forwarded[1])
	}
	// Without a control endpoint and without always-allow, nothing acts.
	g2 := &gateInterceptor{gate: &GateClient{}, host: &HostPolicy{Slug: "ops"}, forward: func(string) {}, emit: func(l string) { emitted = append(emitted, l) }, listIDs: map[string]bool{}, ended: make(chan struct{})}
	g2.fromBot(ctx, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"click","arguments":{}}}`)
	if !strings.Contains(emitted[len(emitted)-1], ConsentRefusal) {
		t.Fatal("acted with nobody to ask")
	}
}

func TestControlConsentRules(t *testing.T) {
	c := &Control{}
	id, s := c.RequestConsent("ops", "wants to click")
	if !s.ConsentOpen || s.ConsentSummary == nil || *s.ConsentSummary != "wants to click" || id == "" {
		t.Fatalf("request: %+v", s)
	}
	if got := c.Decide("ops", "maybe"); !got.ConsentOpen {
		t.Fatal("a nonsense decision closed the request")
	}
	s = c.Decide("ops", ConsentAllow)
	if s.ConsentOpen || s.ConsentDecision != ConsentAllow {
		t.Fatalf("allow: %+v", s)
	}
	id, _ = c.RequestConsent("ops", "again")
	if got := c.ExpireConsent("ops", "other"); !got.ConsentOpen {
		t.Fatal("a stranger's id expired the request")
	}
	if got := c.ExpireConsent("ops", id); got.ConsentOpen || got.ConsentDecision != "" {
		t.Fatalf("expire: %+v", got)
	}
	if err := ValidHostBridgeArgs("/tmp/gawkbot-cua-501.sock", "ops"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][2]string{{"/etc/x.sock", "ops"}, {"/tmp/gawkbot-cua-../x", "ops"}, {"/tmp/gawkbot-cua-1.sock", ""}, {"/tmp/gawkbot-cua-1.sock", "a b"}} {
		if err := ValidHostBridgeArgs(bad[0], bad[1]); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	launch := HostMCPLaunch("/app/gawkbot", "/app/Helpers/cua-driver", "/tmp/gawkbot-cua-1.sock", "ops", ControlEndpoint{URL: "http://127.0.0.1:1/c", Token: "t"})
	if strings.Join(launch.Args, " ") != "computer-mcp --host /tmp/gawkbot-cua-1.sock ops" || launch.Env["GAWKBOT_CUA_DRIVER"] != "/app/Helpers/cua-driver" || launch.Env["CUA_DRIVER_EMBEDDED"] != "1" || launch.Env["WUPHF_COMPUTER_CONTROL_TOKEN"] != "t" {
		t.Fatalf("launch = %+v", launch)
	}
}
