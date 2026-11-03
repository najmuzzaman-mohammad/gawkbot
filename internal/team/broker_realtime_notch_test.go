package team

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRealtimeSessionIsMintedWithTheNotchSession(t *testing.T) {
	t.Setenv("WUPHF_OPENAI_API_KEY", "sk-real-secret")
	t.Setenv("WUPHF_REALTIME_MODEL", "gpt-realtime-2.1")
	stub := &rtStub{status: 200, body: `{"value":"ek_abc","expires_at":999}`}
	withRealtimeStub(t, stub)
	b := newTestBroker(t)
	rec := httptest.NewRecorder()
	b.handleRealtimeSession(rec, httptest.NewRequest(http.MethodPost, "/realtime/session", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Session struct {
			Type         string           `json:"type"`
			Model        string           `json:"model"`
			Instructions string           `json:"instructions"`
			Tools        []map[string]any `json:"tools"`
			Audio        struct {
				Input struct {
					TurnDetection *json.RawMessage `json:"turn_detection"`
					Transcription map[string]any   `json:"transcription"`
				} `json:"input"`
				Output struct {
					Voice string `json:"voice"`
				} `json:"output"`
			} `json:"audio"`
		} `json:"session"`
	}
	if err := json.Unmarshal([]byte(stub.gotBody), &body); err != nil {
		t.Fatalf("mint body: %v\n%s", err, stub.gotBody)
	}
	s := body.Session
	if s.Type != "realtime" || s.Model != "gpt-realtime-2.1" || s.Audio.Output.Voice != realtimeDefaultVoice {
		t.Fatalf("session: %+v", s)
	}
	if !strings.Contains(s.Instructions, "Chief of Staff") || !strings.Contains(s.Instructions, "ask_agent") {
		t.Fatalf("instructions do not name the lead and the routing: %q", s.Instructions)
	}
	// Hold-to-talk: no server turn detection; the page commits the audio.
	if !strings.Contains(stub.gotBody, `"turn_detection":null`) {
		t.Fatalf("turn detection not off: %s", stub.gotBody)
	}
	if s.Audio.Input.Transcription["model"] == "" {
		t.Fatal("input transcription off: the notch could not show what was heard")
	}
	names := map[string]bool{}
	for _, tool := range s.Tools {
		names[tool["name"].(string)] = true
		if tool["type"] != "function" || tool["parameters"] == nil {
			t.Fatalf("tool shape: %+v", tool)
		}
	}
	for _, want := range []string{"get_office_state", "ask_agent", "answer_card", "stop"} {
		if !names[want] {
			t.Fatalf("missing tool %s in %v", want, names)
		}
	}
	if strings.Contains(rec.Body.String(), "sk-real-secret") {
		t.Fatal("the real key leaked")
	}
}

func TestRealtimeStatusSaysWhetherVoiceIsPossible(t *testing.T) {
	t.Setenv("WUPHF_OPENAI_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	b := newTestBroker(t)
	rec := httptest.NewRecorder()
	b.handleRealtimeStatus(rec, httptest.NewRequest(http.MethodGet, "/realtime/status", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Fatalf("no key: %d %s", rec.Code, rec.Body.String())
	}
	t.Setenv("WUPHF_OPENAI_API_KEY", "sk-x")
	t.Setenv("WUPHF_REALTIME_MODEL", "gpt-realtime-2.1")
	rec = httptest.NewRecorder()
	b.handleRealtimeStatus(rec, httptest.NewRequest(http.MethodGet, "/realtime/status", nil))
	if !strings.Contains(rec.Body.String(), `"configured":true`) || !strings.Contains(rec.Body.String(), `"voice":"marin"`) {
		t.Fatalf("with a key: %s", rec.Body.String())
	}
}
