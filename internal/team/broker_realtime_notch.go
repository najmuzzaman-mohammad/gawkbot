package team

// broker_realtime_notch.go: what the notch's talk key gets when an OpenAI
// key is configured. The broker mints the ephemeral key with the whole
// session already set (who the lead is, how to route, which tools exist,
// hold-to-talk, the voice), so the page never edits instructions or tools
// and never sees the real key. GET /realtime/status says whether any of
// this is possible; without a key the notch keeps its on-device dictation.

import (
	"net/http"
	"strings"

	"github.com/nex-crm/wuphf/internal/config"
)

// realtimeDefaultVoice is the voice when none is chosen.
const realtimeDefaultVoice = "marin"

// realtimeVoices are the voices the session accepts; anything else falls
// back to the default rather than failing the mint.
var realtimeVoices = map[string]bool{
	"alloy": true, "ash": true, "ballad": true, "cedar": true, "coral": true,
	"echo": true, "marin": true, "sage": true, "shimmer": true, "verse": true,
}

// realtimeStatusResponse is GET /realtime/status.
type realtimeStatusResponse struct {
	Configured bool   `json:"configured"`
	Model      string `json:"model,omitempty"`
	Voice      string `json:"voice,omitempty"`
}

func (b *Broker) handleRealtimeStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	configured := strings.TrimSpace(config.ResolveOpenAIAPIKey()) != ""
	resp := realtimeStatusResponse{Configured: configured}
	if configured {
		resp.Model = config.ResolveRealtimeModel()
		resp.Voice = realtimeVoice()
	}
	writeJSON(w, http.StatusOK, resp)
}

// realtimeVoice is the configured voice, or the default.
func realtimeVoice() string {
	cfg, _ := config.Load()
	v := strings.ToLower(strings.TrimSpace(cfg.RealtimeVoice))
	if realtimeVoices[v] {
		return v
	}
	return realtimeDefaultVoice
}

// realtimeSessionConfig is the session the ephemeral key is minted with.
// Hold-to-talk: turn detection is off, the page commits the audio when
// the key is let go. Input transcription is on so the page can show what
// was heard.
func (b *Broker) realtimeSessionConfig(model string) map[string]any {
	return map[string]any{
		"type":              "realtime",
		"model":             model,
		"instructions":      b.realtimeInstructions(),
		"tools":             realtimeTools(),
		"output_modalities": []string{"audio"},
		"audio": map[string]any{
			"input": map[string]any{
				"turn_detection": nil,
				"transcription":  map[string]any{"model": "gpt-4o-mini-transcribe"},
			},
			"output": map[string]any{"voice": realtimeVoice()},
		},
	}
}

// realtimeInstructions tells the voice who it is for and how to route.
// It is the notch, not an agent: office status, small talk, and
// answering cards it handles itself; work goes to the lead by tool.
func (b *Broker) realtimeInstructions() string {
	leadName := ""
	if b != nil {
		b.mu.Lock()
		lead := officeLeadSlugFrom(b.members)
		if i, ok := b.memberIndex[lead]; ok && i < len(b.members) {
			leadName = b.members[i].Name
		}
		b.mu.Unlock()
	}
	if leadName == "" {
		leadName = "the lead"
	}
	var sb strings.Builder
	sb.WriteString("You are the voice of gawkbot, an office of AI bots that works for the person talking to you, living in the notch of their Mac. ")
	sb.WriteString("Keep every answer to one or two short sentences; they are listening, not reading. ")
	sb.WriteString("Answer directly about who needs them, who is working, and what a card asks (call get_office_state first when you are not sure). ")
	sb.WriteString("Answer a card with answer_card when they tell you their choice. ")
	sb.WriteString("Anything that needs work done, files, memory, or an integration goes to the lead, ")
	sb.WriteString(leadName)
	sb.WriteString(", with ask_agent, and you say you passed it on. ")
	sb.WriteString("Stop a bot with stop when they ask. Never invent a bot, a card, or a result: say what the office said.")
	return sb.String()
}

// realtimeTools are the function tools the voice may call; the page runs
// each one against the office and returns the result.
func realtimeTools() []map[string]any {
	obj := func(props map[string]any, required ...string) map[string]any {
		schema := map[string]any{"type": "object", "properties": props}
		if len(required) > 0 {
			schema["required"] = required
		}
		return schema
	}
	str := func(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
	tool := func(name, desc string, params map[string]any) map[string]any {
		return map[string]any{"type": "function", "name": name, "description": desc, "parameters": params}
	}
	return []map[string]any{
		tool("get_office_state", "What the office is doing now: the headline, each bot's mood and detail, and the cards that need the person, with their ids and options.", obj(map[string]any{})),
		tool("ask_agent", "Send words to a bot in its direct message. Omit slug for the lead.", obj(map[string]any{
			"slug": str("The bot's slug from get_office_state; omit for the lead."),
			"text": str("What to tell it, in the person's words."),
		}, "text")),
		tool("answer_card", "Answer a card that needs the person, by its id, with one of its option ids or words.", obj(map[string]any{
			"request_id": str("The card's id from get_office_state."),
			"choice_id":  str("The chosen option's id, when choosing an option."),
			"text":       str("Words instead of an option."),
		}, "request_id")),
		tool("stop", "Stop a bot's running work. Omit slug to stop every bot.", obj(map[string]any{
			"slug": str("The bot's slug; omit for everyone."),
		})),
	}
}
