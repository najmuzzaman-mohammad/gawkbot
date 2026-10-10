package agentdetect

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeLog(t *testing.T, path string, mod time.Time, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func TestSessionsAreNamedByWhatTheyAreDoing(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	claude := filepath.Join(home, ".claude", "projects")
	// A busy session with a title that changed as it went: the latest wins.
	writeLog(t, filepath.Join(claude, "-Users-me-shop", "aaa.jsonl"), now.Add(-30*time.Second),
		`{"type":"user","cwd":"/Users/me/shop","message":{"content":"hi"}}`,
		`{"type":"ai-title","aiTitle":"Set up the repo"}`,
		`{"type":"last-prompt","lastPrompt":"now fix the checkout test"}`,
		`{"type":"ai-title","aiTitle":"Fix the flaky checkout test"}`,
	)
	// No title yet: the human's last prompt names it, cut to a line.
	writeLog(t, filepath.Join(claude, "-Users-me-site", "bbb.jsonl"), now.Add(-10*time.Minute),
		`{"type":"user","cwd":"/Users/me/site","message":{"content":"x"}}`,
		`{"type":"last-prompt","lastPrompt":"Rewrite the pricing page so that the three plans read clearly on a phone and the annual toggle is obvious"}`,
	)
	// A sub-agent's log is not a session the human started.
	writeLog(t, filepath.Join(claude, "-Users-me-shop", "side.jsonl"), now.Add(-time.Minute),
		`{"type":"user","cwd":"/Users/me/shop","isSidechain":true}`,
		`{"type":"ai-title","aiTitle":"Sub-agent"}`,
	)
	// Finished long ago: not listed.
	writeLog(t, filepath.Join(claude, "-Users-me-old", "old.jsonl"), now.Add(-9*time.Hour),
		`{"type":"user","cwd":"/Users/me/old"}`,
		`{"type":"ai-title","aiTitle":"Old work"}`,
	)
	// Codex: the folder from the meta record, the opening request as the
	// name, skipping the context Codex injects ahead of it.
	codex := filepath.Join(home, ".codex", "sessions", "2026", "10", "09")
	writeLog(t, filepath.Join(codex, "rollout-1.jsonl"), now.Add(-5*time.Minute),
		`{"type":"session_meta","payload":{"id":"t-1","cwd":"/Users/me/api","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"# AGENTS.md instructions for /Users/me/api"},{"text":"<environment_context>ignored</environment_context>"}]}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"Add rate limits to the login route"}]}}`,
	)
	// Codex named this thread itself: that name wins, and the latest rename.
	writeLog(t, filepath.Join(codex, "rollout-2.jsonl"), now.Add(-20*time.Minute),
		`{"type":"session_meta","payload":{"id":"t-2","cwd":"/Users/me/web","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"make the header sticky please"}]}}`,
	)
	writeLog(t, filepath.Join(home, ".codex", "session_index.jsonl"), now,
		`{"id":"t-2","thread_name":"Header work"}`,
		`{"id":"t-2","thread_name":"Make the header sticky"}`,
	)
	// Codex's own reviewer and sub-agent sessions are not the human's.
	writeLog(t, filepath.Join(codex, "rollout-3.jsonl"), now.Add(-time.Minute),
		`{"type":"session_meta","payload":{"id":"t-3","cwd":"/Users/me/api","thread_source":"guardian_review"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"The following is the Codex agent history"}]}}`,
	)
	// An office's own bot turn, in its scratch folder: already on the roster
	// as that bot, so not a session to list.
	writeLog(t, filepath.Join(claude, "-Users-me--wuphf-agent-scratch-cos", "bot.jsonl"), now.Add(-time.Minute),
		`{"type":"user","cwd":"/Users/me/.wuphf/agent-scratch/cos"}`,
		`{"type":"ai-title","aiTitle":"A bot turn"}`,
	)
	// A one-word prompt names nothing: the folder does.
	writeLog(t, filepath.Join(claude, "-Users-me-docs", "ccc.jsonl"), now.Add(-25*time.Minute),
		`{"type":"user","cwd":"/Users/me/docs"}`,
		`{"type":"last-prompt","lastPrompt":"continue"}`,
	)

	s := &Scanner{Home: func() (string, error) { return home, nil }}
	scan := []Detection{
		{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}},
		{ID: "codex", Name: "Codex CLI", Running: []Process{{PID: 2}}},
	}
	got := s.Sessions(scan, now)
	if len(got) != 5 {
		t.Fatalf("sessions = %+v, want 5", got)
	}
	// Newest first.
	if got[0].Title != "Fix the flaky checkout test" || got[0].Project != "shop" || got[0].Tool != "claude-code" || !got[0].Active {
		t.Fatalf("first = %+v", got[0])
	}
	if got[1].Tool != "codex" || got[1].Title != "Add rate limits to the login route" || got[1].Project != "api" || got[1].Active {
		t.Fatalf("second = %+v", got[1])
	}
	if got[2].Project != "site" || !strings.HasPrefix(got[2].Title, "Rewrite the pricing page") || !strings.HasSuffix(got[2].Title, "…") || len([]rune(got[2].Title)) > sessionTitleMax+1 {
		t.Fatalf("third = %+v", got[2])
	}
	if got[3].Title != "Make the header sticky" || got[3].Project != "web" {
		t.Fatalf("fourth = %+v", got[3])
	}
	if got[4].Title != "docs" {
		t.Fatalf("fifth = %+v", got[4])
	}

	// A tool with nothing running lists nothing, whatever its logs say.
	if only := s.Sessions(scan[1:], now); len(only) != 2 || only[0].Tool != "codex" {
		t.Fatalf("with claude not running: %+v", only)
	}
	if none := s.Sessions(nil, now); len(none) != 0 {
		t.Fatalf("with nothing running: %+v", none)
	}
}

// The title is read from the tail of a log far larger than the read window.
func TestSessionTitleComesFromTheTailOfALargeLog(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	filler := `{"type":"assistant","message":{"content":"` + strings.Repeat("x", 4000) + `"}}`
	lines := []string{`{"type":"user","cwd":"/Users/me/big"}`, `{"type":"ai-title","aiTitle":"An early title"}`}
	for i := 0; i < 200; i++ {
		lines = append(lines, filler)
	}
	lines = append(lines, `{"type":"ai-title","aiTitle":"The latest title"}`)
	writeLog(t, filepath.Join(home, ".claude", "projects", "-Users-me-big", "big.jsonl"), now, lines...)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	got := s.Sessions([]Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}, now)
	if len(got) != 1 || got[0].Title != "The latest title" || got[0].Project != "big" {
		t.Fatalf("sessions = %+v", got)
	}
}

// When a long stretch of work has pushed every title out of the tail, the
// log is read through once and the title found there is remembered.
func TestSessionTitleIsFoundBeyondTheTailAndRemembered(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	path := filepath.Join(home, ".claude", "projects", "-Users-me-long", "long.jsonl")
	filler := `{"type":"assistant","message":{"content":"` + strings.Repeat("x", 4000) + `"}}`
	lines := []string{`{"type":"user","cwd":"/Users/me/long"}`}
	for i := 0; i < 40; i++ {
		lines = append(lines, filler)
	}
	lines = append(lines, `{"type":"ai-title","aiTitle":"Buried in the middle"}`)
	for i := 0; i < 200; i++ {
		lines = append(lines, filler)
	}
	writeLog(t, path, now, lines...)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	scan := []Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}
	if got := s.Sessions(scan, now); len(got) != 1 || got[0].Title != "Buried in the middle" {
		t.Fatalf("sessions = %+v", got)
	}
	// Remembered: the next scan does not need the middle of the file.
	if known := claudeTitles.byPath[path]; known != "Buried in the middle" {
		t.Fatalf("remembered %q", known)
	}
}

// A session says what it is doing: writing now, finished and waiting for
// the human, or stopped mid-turn.
func TestSessionState(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	claude := filepath.Join(home, ".claude", "projects")
	writeLog(t, filepath.Join(claude, "-Users-me-a", "busy.jsonl"), now.Add(-20*time.Second),
		`{"type":"user","cwd":"/Users/me/a"}`,
		`{"type":"ai-title","aiTitle":"Busy right now"}`,
		`{"type":"assistant","message":{"stop_reason":"end_turn"}}`,
	)
	// Finished three hours ago and still waiting: listed, and it is the
	// human's turn. Records after the last message do not hide it.
	writeLog(t, filepath.Join(claude, "-Users-me-b", "done.jsonl"), now.Add(-3*time.Hour),
		`{"type":"user","cwd":"/Users/me/b"}`,
		`{"type":"ai-title","aiTitle":"Finished and waiting"}`,
		`{"type":"assistant","message":{"stop_reason":"tool_use"}}`,
		`{"type":"user","message":{"content":"tool result"}}`,
		`{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Both fixes pass.\nWhich one should I keep?"}]}}`,
		`{"type":"system","subtype":"turn_duration"}`,
	)
	// Stopped on a tool call: the log cannot say why, so it is only quiet.
	writeLog(t, filepath.Join(claude, "-Users-me-c", "mid.jsonl"), now.Add(-10*time.Minute),
		`{"type":"user","cwd":"/Users/me/c"}`,
		`{"type":"ai-title","aiTitle":"Stopped on a command"}`,
		`{"type":"assistant","message":{"stop_reason":"tool_use"}}`,
	)
	codex := filepath.Join(home, ".codex", "sessions", "2026", "10", "09")
	writeLog(t, filepath.Join(codex, "rollout-done.jsonl"), now.Add(-40*time.Minute),
		`{"type":"session_meta","payload":{"id":"c-1","cwd":"/Users/me/d","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"Tidy the migration scripts"}]}}`,
		`{"type":"event_msg","payload":{"type":"task_started"}}`,
		`{"type":"event_msg","payload":{"type":"agent_message","message":"Scripts are tidy. Run them on staging?"}}`,
		`{"type":"event_msg","payload":{"type":"task_complete"}}`,
	)
	writeLog(t, filepath.Join(codex, "rollout-mid.jsonl"), now.Add(-50*time.Minute),
		`{"type":"session_meta","payload":{"id":"c-2","cwd":"/Users/me/e","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"Port the importer to the new API"}]}}`,
		`{"type":"event_msg","payload":{"type":"task_complete"}}`,
		`{"type":"event_msg","payload":{"type":"task_started"}}`,
	)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	scan := []Detection{
		{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}},
		{ID: "codex", Name: "Codex CLI", Running: []Process{{PID: 2}}},
	}
	want := map[string]string{
		"Busy right now":                   SessionWorking,
		"Finished and waiting":             SessionYourTurn,
		"Stopped on a command":             SessionQuiet,
		"Tidy the migration scripts":       SessionYourTurn,
		"Port the importer to the new API": SessionQuiet,
	}
	got := s.Sessions(scan, now)
	if len(got) != len(want) {
		t.Fatalf("sessions = %+v, want %d", got, len(want))
	}
	said := map[string]string{
		"Finished and waiting":       "Both fixes pass. Which one should I keep?",
		"Tidy the migration scripts": "Scripts are tidy. Run them on staging?",
	}
	for _, sess := range got {
		if want[sess.Title] != sess.State {
			t.Errorf("%q state = %q, want %q", sess.Title, sess.State, want[sess.Title])
		}
		if said[sess.Title] != sess.LastSaid {
			t.Errorf("%q last said %q, want %q", sess.Title, sess.LastSaid, said[sess.Title])
		}
	}
	if long := lastWords(strings.Repeat("word ", 200)+"the end?", 40); !strings.HasPrefix(long, "…") || !strings.HasSuffix(long, "the end?") || len([]rune(long)) > 41 {
		t.Errorf("lastWords = %q", long)
	}
}

// Only the newest sessions are read, however many logs a day leaves.
func TestSessionsReadOnlyTheNewest(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	claude := filepath.Join(home, ".claude", "projects", "-Users-me-many")
	for i := 0; i < sessionLimit+6; i++ {
		writeLog(t, filepath.Join(claude, "s"+string(rune('a'+i))+".jsonl"), now.Add(-time.Duration(i+1)*time.Minute),
			`{"type":"user","cwd":"/Users/me/many"}`,
			`{"type":"ai-title","aiTitle":"Session `+string(rune('a'+i))+`"}`,
		)
	}
	// A run some program started, newer than all but two of the sessions. It
	// is skipped, and being skipped must not use up a place in the list.
	writeLog(t, filepath.Join(claude, "automated.jsonl"), now.Add(-150*time.Second),
		`{"type":"user","cwd":"/Users/me/many","entrypoint":"sdk-py"}`,
		`{"type":"ai-title","aiTitle":"Automated review"}`,
	)
	reads := 0
	got := recentSessions(filepath.Dir(claude), 2, now, func(path string, info os.FileInfo) (Session, bool) {
		reads++
		return claudeSession(path, info, "Claude Code")
	})
	// One read more than the limit, exactly: the automated run sits among the
	// newest logs, and a log has to be read before it can be skipped. The
	// limit counts sessions that are kept, so the full number still comes back.
	if len(got) != sessionLimit || reads != sessionLimit+1 {
		t.Fatalf("listed %d after %d reads, want %d and %d", len(got), reads, sessionLimit, sessionLimit+1)
	}
	if got[0].Title != "Session a" {
		t.Fatalf("newest first: %+v", got[0])
	}
	for _, sess := range got {
		if sess.Title == "Automated review" {
			t.Fatalf("the automated run was listed: %+v", sess)
		}
	}
	// The twelfth kept session is the twelfth real one, not the eleventh.
	if last := got[sessionLimit-1].Title; last != "Session "+string(rune('a'+sessionLimit-1)) {
		t.Fatalf("last listed = %q; the skipped log took a place in the list", last)
	}
}

// The badge on a session's avatar says what it is running on right now, so
// the model is the last one its log names, not the first.
func TestSessionModelIsTheLastOneTheLogNames(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	claude := filepath.Join(home, ".claude", "projects")
	// Switched model mid-session, then hit an API error: Claude Code writes
	// the error as a "<synthetic>" assistant message, which names no model.
	writeLog(t, filepath.Join(claude, "-Users-me-a", "switched.jsonl"), now.Add(-time.Minute),
		`{"type":"user","cwd":"/Users/me/a"}`,
		`{"type":"ai-title","aiTitle":"Switched model"}`,
		`{"type":"assistant","message":{"model":"claude-sonnet-5-5","stop_reason":"end_turn"}}`,
		`{"type":"assistant","message":{"model":"claude-opus-5-5","stop_reason":"end_turn"}}`,
		`{"type":"assistant","message":{"model":"<synthetic>","stop_reason":"stop_sequence"}}`,
	)
	// Opened but has not taken a turn: no model yet.
	writeLog(t, filepath.Join(claude, "-Users-me-b", "fresh.jsonl"), now.Add(-2*time.Minute),
		`{"type":"user","cwd":"/Users/me/b"}`,
		`{"type":"ai-title","aiTitle":"Just opened"}`,
	)
	// Codex names the model on each turn's context, not on the session meta.
	codex := filepath.Join(home, ".codex", "sessions", "2026", "10", "09")
	writeLog(t, filepath.Join(codex, "rollout-m.jsonl"), now.Add(-3*time.Minute),
		`{"type":"session_meta","payload":{"id":"c-9","cwd":"/Users/me/c","thread_source":"user","model_provider":"openai"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"Add rate limits to the login route"}]}}`,
		`{"type":"turn_context","payload":{"cwd":"/Users/me/c","model":"gpt-5.5"}}`,
		`{"type":"turn_context","payload":{"cwd":"/Users/me/c","model":"gpt-6-astra"}}`,
	)

	s := &Scanner{Home: func() (string, error) { return home, nil }}
	scan := []Detection{
		{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}},
		{ID: "codex", Name: "Codex CLI", Running: []Process{{PID: 2}}},
	}
	models := map[string]string{}
	for _, sess := range s.Sessions(scan, now) {
		models[sess.Title] = sess.Model
	}
	want := map[string]string{
		"Switched model":                     "claude-opus-5-5",
		"Just opened":                        "",
		"Add rate limits to the login route": "gpt-6-astra",
	}
	if len(models) != len(want) {
		t.Fatalf("sessions = %v, want %d of them", models, len(want))
	}
	for title, model := range want {
		if got, ok := models[title]; !ok || got != model {
			t.Errorf("model of %q = %q (listed: %v), want %q", title, got, ok, model)
		}
	}
}

// Claude Code stamps how each run was started. Only a run started at a
// terminal is a session the person opened; SDK runs (a commit-time review,
// a script) are not, and a log too old to carry the stamp is kept.
func TestClaudeSessionsStartedByAProgramAreNotListed(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	claude := filepath.Join(home, ".claude", "projects", "-Users-me-shop")
	log := func(name, first string) {
		writeLog(t, filepath.Join(claude, name+".jsonl"), now.Add(-time.Minute),
			first,
			`{"type":"ai-title","aiTitle":"`+name+`"}`,
		)
	}
	log("terminal", `{"type":"user","cwd":"/Users/me/shop","entrypoint":"cli"}`)
	log("sdk python", `{"type":"user","cwd":"/Users/me/shop","entrypoint":"sdk-py"}`)
	log("sdk cli", `{"type":"user","cwd":"/Users/me/shop","entrypoint":"sdk-cli"}`)
	log("no stamp", `{"type":"user","cwd":"/Users/me/shop"}`)
	// The stamp is not on the first record, nor on the one with the folder.
	writeLog(t, filepath.Join(claude, "late stamp.jsonl"), now.Add(-time.Minute),
		`{"type":"summary"}`,
		`{"type":"user","cwd":"/Users/me/shop"}`,
		`{"type":"assistant","entrypoint":"sdk-py"}`,
		`{"type":"ai-title","aiTitle":"late stamp"}`,
	)

	s := &Scanner{Home: func() (string, error) { return home, nil }}
	got := map[string]bool{}
	for _, sess := range s.Sessions([]Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}, now) {
		got[sess.Title] = true
	}
	want := map[string]bool{"terminal": true, "no stamp": true}
	if len(got) != len(want) {
		t.Fatalf("listed = %v, want exactly %v", got, want)
	}
	for title := range want {
		if !got[title] {
			t.Fatalf("listed = %v, want %q kept", got, title)
		}
	}
}

func writeRegistry(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Whether a session is open comes from Claude Code's own list of running
// sessions, checked against the processes that are really there.
func TestOpenSessionsReadsClaudeCodesRegistry(t *testing.T) {
	home := t.TempDir()
	reg := filepath.Join(home, ".claude", "sessions")
	writeRegistry(t, reg, "101.json", `{"pid":101,"sessionId":"aaa","cwd":"/Users/me/shop","kind":"interactive","entrypoint":"cli","status":"busy","name":"x"}`)
	writeRegistry(t, reg, "102.json", `{"pid":102,"sessionId":"bbb","kind":"interactive","status":"idle"}`)
	// Its process crashed and left the file behind.
	writeRegistry(t, reg, "103.json", `{"pid":103,"sessionId":"ccc","kind":"interactive","status":"idle"}`)
	// Running, but not a window a person sits at. It still holds the
	// session: a resume against it would write a second conversation.
	writeRegistry(t, reg, "104.json", `{"pid":104,"sessionId":"ddd","kind":"background","status":"busy"}`)
	// Claude Code has been seen to leave bytes after the entry. The entry
	// is still read: a whole-file parse threw a live session away.
	writeRegistry(t, reg, "105.json", `{"pid":105,"sessionId":"eee","kind":"interactive","status":"idle"}}{"stale":true`)
	// Not a registry file at all.
	writeRegistry(t, reg, "notes.txt", `{"pid":101,"sessionId":"zzz","kind":"interactive"}`)

	s := &Scanner{Home: func() (string, error) { return home, nil }, alivePIDs: map[int]bool{101: true, 102: true, 104: true, 105: true}}
	open, known := s.OpenSessions()
	if !known {
		t.Fatal("a registry whose every entry can be read must be known")
	}
	want := map[string]OpenSession{
		"claude-code:aaa": {PID: 101, Busy: true, Interactive: true},
		"claude-code:bbb": {PID: 102, Interactive: true},
		"claude-code:ddd": {PID: 104, Busy: true},
		"claude-code:eee": {PID: 105, Interactive: true},
	}
	if len(open) != len(want) {
		t.Fatalf("open = %+v, want %+v", open, want)
	}
	for id, w := range want {
		if open[id] != w {
			t.Errorf("open[%s] = %+v, want %+v", id, open[id], w)
		}
	}
}

// One entry that cannot be understood is one session nobody can vouch for,
// and it would be the one missing from the answer. A missing session reads
// as closed, and a closed session may be resumed, which forks a live one.
// So nothing is known then, even with other entries that read fine.
func TestOneUnreadableRegistryEntryMakesOpennessUnknown(t *testing.T) {
	good := `{"pid":101,"sessionId":"aaa","kind":"interactive","status":"idle"}`
	for name, bad := range map[string]string{
		"not json":          `{not json`,
		"wrong types":       `{"pid":"106","sessionId":7}`,
		"no pid or session": `{"kind":"interactive"}`,
		"an array":          `[]`,
		"empty":             ``,
		"a pid, no session": `{"pid":106}`,
		"a session, no pid": `{"sessionId":"zzz"}`,
	} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			reg := filepath.Join(home, ".claude", "sessions")
			writeRegistry(t, reg, "101.json", good)
			writeRegistry(t, reg, "106.json", bad)
			s := &Scanner{Home: func() (string, error) { return home, nil }, alivePIDs: map[int]bool{101: true}}
			if open, known := s.OpenSessions(); known {
				t.Fatalf("known with an unreadable entry beside a good one; open = %+v", open)
			}
		})
	}
}

// The log's own last write is the check that does not go through the
// registry.
func TestClaudeLogLastWrite(t *testing.T) {
	home := t.TempDir()
	const id = "1a2b3c4d-0000-4000-8000-000000000001"
	older := time.Date(2026, 10, 9, 11, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	// The same session in two project folders: the later write is the one.
	writeLog(t, filepath.Join(home, ".claude", "projects", "-Users-me-a", id+".jsonl"), older, `{"type":"user"}`)
	writeLog(t, filepath.Join(home, ".claude", "projects", "-Users-me-b", id+".jsonl"), newer, `{"type":"user"}`)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	if got, ok := s.ClaudeLogLastWrite(id); !ok || !got.Equal(newer) {
		t.Fatalf("last write = %v (%v), want %v", got, ok, newer)
	}
	if got, ok := s.ClaudeLogLastWrite(strings.ToUpper(id)); !ok || !got.Equal(newer) {
		t.Fatalf("an upper-case id = %v (%v), want %v", got, ok, newer)
	}
	for _, bad := range []string{"", "nope", "../" + id, id + "/../x", "claude-code:" + id, "1a2b3c4d-0000-4000-8000-00000000000Z"} {
		if _, ok := s.ClaudeLogLastWrite(bad); ok {
			t.Errorf("found a log for %q, which is not a session id", bad)
		}
	}
	if _, ok := s.ClaudeLogLastWrite("1a2b3c4d-0000-4000-8000-000000000002"); ok {
		t.Error("found a log for a session that has none")
	}
}

// The registry is undocumented. When it cannot be read, the answer is
// "unknown", never "everything is closed".
func TestOpenSessionsIsUnknownWithoutAUsableRegistry(t *testing.T) {
	alive := map[int]bool{101: true}
	cases := map[string]func(t *testing.T, home string) *Scanner{
		"no registry directory": func(t *testing.T, home string) *Scanner {
			return &Scanner{Home: func() (string, error) { return home, nil }, alivePIDs: alive}
		},
		"an empty registry directory": func(t *testing.T, home string) *Scanner {
			if err := os.MkdirAll(filepath.Join(home, ".claude", "sessions"), 0o755); err != nil {
				t.Fatal(err)
			}
			return &Scanner{Home: func() (string, error) { return home, nil }, alivePIDs: alive}
		},
		"nothing in it parses": func(t *testing.T, home string) *Scanner {
			writeRegistry(t, filepath.Join(home, ".claude", "sessions"), "101.json", `{not json`)
			writeRegistry(t, filepath.Join(home, ".claude", "sessions"), "102.json", `[]`)
			return &Scanner{Home: func() (string, error) { return home, nil }, alivePIDs: alive}
		},
		"the process list is not available": func(t *testing.T, home string) *Scanner {
			writeRegistry(t, filepath.Join(home, ".claude", "sessions"), "101.json", `{"pid":101,"sessionId":"aaa","kind":"interactive"}`)
			return &Scanner{Home: func() (string, error) { return home, nil }}
		},
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			open, known := build(t, t.TempDir()).OpenSessions()
			if known || open != nil {
				t.Fatalf("open=%v known=%v, want unknown", open, known)
			}
		})
	}
}

// Sessions carries what the registry says onto each Claude Code session, and
// says nothing (not "closed") when there is no registry to ask.
func TestSessionsSayWhetherTheyAreOpen(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	claude := filepath.Join(home, ".claude", "projects", "-Users-me-shop")
	for _, id := range []string{"aaa", "bbb"} {
		writeLog(t, filepath.Join(claude, id+".jsonl"), now.Add(-time.Minute),
			`{"type":"user","cwd":"/Users/me/shop","entrypoint":"cli"}`,
			`{"type":"ai-title","aiTitle":"Session `+id+`"}`,
		)
	}
	codex := filepath.Join(home, ".codex", "sessions", "2026", "10", "09")
	writeLog(t, filepath.Join(codex, "rollout-1.jsonl"), now.Add(-time.Minute),
		`{"type":"session_meta","payload":{"id":"t-1","cwd":"/Users/me/api","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"Add rate limits to the login route"}]}}`,
	)
	scan := []Detection{
		{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 101}}},
		{ID: "codex", Name: "Codex CLI", Running: []Process{{PID: 2}}},
	}
	byID := func(s *Scanner) map[string]Session {
		out := map[string]Session{}
		for _, sess := range s.Sessions(scan, now) {
			out[sess.ID] = sess
		}
		if len(out) != 3 {
			t.Fatalf("sessions = %+v, want the two Claude Code sessions and the Codex one", out)
		}
		return out
	}

	// No registry: nothing is said about any of them.
	for id, sess := range byID(&Scanner{Home: func() (string, error) { return home, nil }, alivePIDs: map[int]bool{101: true}}) {
		if sess.OpenKnown || sess.Open || sess.PID != 0 {
			t.Fatalf("%s without a registry = %+v, want openness unknown", id, sess)
		}
	}

	writeRegistry(t, filepath.Join(home, ".claude", "sessions"), "101.json", `{"pid":101,"sessionId":"aaa","kind":"interactive","status":"idle"}`)
	got := byID(&Scanner{Home: func() (string, error) { return home, nil }, alivePIDs: map[int]bool{101: true}})
	if a := got["claude-code:aaa"]; !a.OpenKnown || !a.Open || a.PID != 101 {
		t.Fatalf("aaa = %+v, want open with pid 101", a)
	}
	if b := got["claude-code:bbb"]; !b.OpenKnown || b.Open || b.PID != 0 {
		t.Fatalf("bbb = %+v, want known to be closed", b)
	}
	// Codex has no such list: always unknown.
	if c := got["codex:rollout-1"]; c.OpenKnown || c.Open {
		t.Fatalf("codex = %+v, want openness unknown", c)
	}
}

// CLAUDE_CONFIG_DIR moves both the logs and the registry.
func TestClaudeConfigDirIsHonoured(t *testing.T) {
	home, elsewhere := t.TempDir(), t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	writeLog(t, filepath.Join(home, ".claude", "projects", "-Users-me-shop", "default.jsonl"), now.Add(-time.Minute),
		`{"type":"user","cwd":"/Users/me/shop"}`, `{"type":"ai-title","aiTitle":"In the default folder"}`)
	writeLog(t, filepath.Join(elsewhere, "projects", "-Users-me-shop", "moved.jsonl"), now.Add(-time.Minute),
		`{"type":"user","cwd":"/Users/me/shop"}`, `{"type":"ai-title","aiTitle":"In the configured folder"}`)
	writeRegistry(t, filepath.Join(elsewhere, "sessions"), "101.json", `{"pid":101,"sessionId":"moved","kind":"interactive"}`)
	scan := []Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 101}}}}
	titles := func(env string) []string {
		s := &Scanner{
			Home:      func() (string, error) { return home, nil },
			Getenv:    func(key string) string { return map[string]string{claudeConfigDirEnv: env}[key] },
			alivePIDs: map[int]bool{101: true},
		}
		var out []string
		for _, sess := range s.Sessions(scan, now) {
			out = append(out, sess.Title)
			if env != "" && (!sess.OpenKnown || !sess.Open) {
				t.Fatalf("with the config dir set, %+v should be open: the registry moved too", sess)
			}
		}
		return out
	}
	if got := titles(""); len(got) != 1 || got[0] != "In the default folder" {
		t.Fatalf("unset: %v", got)
	}
	if got := titles(elsewhere); len(got) != 1 || got[0] != "In the configured folder" {
		t.Fatalf("set: %v", got)
	}
}

// A real Scan is what tells the registry reader which pids are alive.
func TestScanFeedsTheRegistryItsProcessList(t *testing.T) {
	home := t.TempDir()
	writeRegistry(t, filepath.Join(home, ".claude", "sessions"), "101.json", `{"pid":101,"sessionId":"aaa","kind":"interactive"}`)
	writeRegistry(t, filepath.Join(home, ".claude", "sessions"), "999.json", `{"pid":999,"sessionId":"gone","kind":"interactive"}`)
	s := &Scanner{
		Home: func() (string, error) { return home, nil },
		Processes: func(context.Context) ([]rawProcess, error) {
			return []rawProcess{{PID: 101, Args: []string{"claude"}}}, nil
		},
	}
	if _, known := s.OpenSessions(); known {
		t.Fatal("before any Scan the process list is not known, so openness must not be either")
	}
	s.Scan(t.Context())
	open, known := s.OpenSessions()
	if !known || len(open) != 1 || open["claude-code:aaa"].PID != 101 {
		t.Fatalf("open=%+v known=%v, want only aaa: pid 999 is not running", open, known)
	}
}

// A run started with a very long prompt opens its log with one record
// bigger than the head that is read, so the head holds no whole record. The
// entrypoint and the folder are then taken from the tail.
func TestClaudeLogWithAHugeFirstRecordIsStillJudged(t *testing.T) {
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	huge := `{"type":"queue-operation","content":"` + strings.Repeat("x", sessionHeadBytes+4096) + `"}`
	// Enough after it that the tail read starts past the first record too.
	filler := `{"type":"progress","note":"` + strings.Repeat("y", 2000) + `"}`
	build := func(t *testing.T, entrypoint string) []Session {
		t.Helper()
		home := t.TempDir()
		lines := []string{huge, `{"type":"queue-operation","content":"second"}`}
		lines = append(lines, `{"type":"user","cwd":"/Users/me/shop","entrypoint":"`+entrypoint+`"}`)
		for i := 0; i < (sessionTailBytes/len(filler))+20; i++ {
			lines = append(lines, filler)
		}
		lines = append(lines,
			`{"type":"assistant","cwd":"/Users/me/shop","entrypoint":"`+entrypoint+`","message":{"model":"claude-opus-5-5","stop_reason":"end_turn"}}`,
			`{"type":"ai-title","aiTitle":"Review of the avatar change"}`,
		)
		path := filepath.Join(home, ".claude", "projects", "-Users-me-shop", "big.jsonl")
		writeLog(t, path, now.Add(-time.Minute), lines...)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		// The shape under test: no whole record in the head, and the first
		// stamped record (line 3) outside the tail as well.
		head, tail := headAndTail(path, info.Size())
		if len(head) != 0 {
			t.Fatalf("setup: the head holds %d whole record(s), want none", len(head))
		}
		if info.Size() <= int64(len(huge))+sessionTailBytes+4096 || len(tail) == 0 {
			t.Fatalf("setup: log is %d bytes; the tail must start well past the first records", info.Size())
		}
		s := &Scanner{Home: func() (string, error) { return home, nil }}
		return s.Sessions([]Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}, now)
	}

	if got := build(t, "sdk-py"); len(got) != 0 {
		t.Fatalf("an automated run with a huge first record was listed: %+v", got)
	}
	got := build(t, "cli")
	if len(got) != 1 {
		t.Fatalf("a terminal session with a huge first record: listed %+v, want it", got)
	}
	if got[0].Cwd != "/Users/me/shop" || got[0].Project != "shop" || got[0].Title != "Review of the avatar change" {
		t.Fatalf("session = %+v, want its folder and title", got[0])
	}
}

// The sub-agent mark is read from the head only. A session whose log ends on
// a sub-agent's records, with its own first record too big for the head, is
// still the person's session.
func TestSidechainRecordsInTheTailDoNotHideASession(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	huge := `{"type":"queue-operation","content":"` + strings.Repeat("x", sessionHeadBytes+4096) + `"}`
	writeLog(t, filepath.Join(home, ".claude", "projects", "-Users-me-shop", "main.jsonl"), now.Add(-time.Minute),
		huge,
		`{"type":"ai-title","aiTitle":"Main session"}`,
		`{"type":"assistant","cwd":"/Users/me/shop","entrypoint":"cli","isSidechain":true}`,
	)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	got := s.Sessions([]Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}, now)
	if len(got) != 1 || got[0].Title != "Main session" || got[0].Project != "shop" {
		t.Fatalf("sessions = %+v, want the main session with its folder", got)
	}
}

// Whether anything can be open is known in two cases only: the registry
// names a live interactive session, or the scan found no Claude Code process
// at all. Claude Code running with a registry that names none of it is what
// a release that moved the registry would look like, and stays unknown.
func TestOpenSessionsIsKnownOnlyFromALiveEntryOrNoClaudeCodeAtAll(t *testing.T) {
	procs := func(list ...rawProcess) func(context.Context) ([]rawProcess, error) {
		return func(context.Context) ([]rawProcess, error) { return list, nil }
	}
	claude := rawProcess{PID: 101, Args: []string{"claude"}}
	other := rawProcess{PID: 7, Args: []string{"vim"}}
	live := `{"pid":101,"sessionId":"aaa","kind":"interactive"}`
	cases := []struct {
		name      string
		registry  map[string]string // nil: no registry folder at all
		processes func(context.Context) ([]rawProcess, error)
		wantKnown bool
		wantOpen  []string
	}{
		{"a live interactive entry", map[string]string{"101.json": live}, procs(claude, other), true, []string{"claude-code:aaa"}},
		{"no Claude Code process, no registry", nil, procs(other), true, nil},
		{"no Claude Code process, empty registry", map[string]string{}, procs(other), true, nil},
		{"no Claude Code process, a stale entry left behind", map[string]string{"101.json": live}, procs(other), true, nil},
		{"Claude Code running, no registry", nil, procs(claude), false, nil},
		{"Claude Code running, empty registry", map[string]string{}, procs(claude), false, nil},
		// A background entry with a live process holds its session: it is
		// open, and a registry that answers for a live process is known.
		{"Claude Code running, only a background entry", map[string]string{"101.json": `{"pid":101,"sessionId":"aaa","kind":"background"}`}, procs(claude), true, []string{"claude-code:aaa"}},
		{"Claude Code running, only another process's stale entry", map[string]string{"55.json": `{"pid":55,"sessionId":"old","kind":"interactive"}`}, procs(claude), false, nil},
		{"the process list failed", map[string]string{"101.json": live}, func(context.Context) ([]rawProcess, error) { return nil, os.ErrPermission }, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			if tc.registry != nil {
				dir := filepath.Join(home, ".claude", "sessions")
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				for name, body := range tc.registry {
					writeRegistry(t, dir, name, body)
				}
			}
			s := &Scanner{Home: func() (string, error) { return home, nil }, Processes: tc.processes}
			s.Scan(t.Context())
			open, known := s.OpenSessions()
			if known != tc.wantKnown || len(open) != len(tc.wantOpen) {
				t.Fatalf("open=%v known=%v, want known=%v open=%v", open, known, tc.wantKnown, tc.wantOpen)
			}
			for _, id := range tc.wantOpen {
				if _, ok := open[id]; !ok {
					t.Fatalf("open=%v, want %s in it", open, id)
				}
			}
		})
	}
}

// A log is read only when it is a plain file, and a Claude Code log's folder
// is believed only when the log sits in that folder's own project folder.
func TestSessionLogsMustBePlainFilesInTheirOwnProjectFolder(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	projects := filepath.Join(home, ".claude", "projects")
	log := func(dir, id, cwd, title string) string {
		path := filepath.Join(projects, dir, id+".jsonl")
		writeLog(t, path, now.Add(-time.Minute),
			`{"type":"user","cwd":"`+cwd+`","entrypoint":"cli"}`,
			`{"type":"ai-title","aiTitle":"`+title+`"}`)
		return path
	}
	log("-Users-me-shop", "honest", "/Users/me/shop", "In its own folder")
	log("-Users-me-my-app-v1-2", "dotted", "/Users/me/my.app_v1 2", "Dots, underscores, and spaces become dashes")
	// Filed under one project, claiming another's folder.
	log("-Users-me-shop", "liar", "/Users/me/secrets", "Claims another folder")
	// A plain log somewhere else on the machine, linked in.
	outside := filepath.Join(t.TempDir(), "elsewhere.jsonl")
	writeLog(t, outside, now.Add(-time.Minute),
		`{"type":"user","cwd":"/Users/me/shop","entrypoint":"cli"}`,
		`{"type":"ai-title","aiTitle":"Linked in"}`)
	if err := os.Symlink(outside, filepath.Join(projects, "-Users-me-shop", "linked.jsonl")); err != nil {
		t.Fatal(err)
	}
	// A whole project folder that is a link.
	real := filepath.Join(t.TempDir(), "-Users-me-other")
	writeLog(t, filepath.Join(real, "indir.jsonl"), now.Add(-time.Minute),
		`{"type":"user","cwd":"/Users/me/other","entrypoint":"cli"}`,
		`{"type":"ai-title","aiTitle":"In a linked folder"}`)
	if err := os.Symlink(real, filepath.Join(projects, "-Users-me-other")); err != nil {
		t.Fatal(err)
	}

	s := &Scanner{Home: func() (string, error) { return home, nil }}
	got := map[string]string{}
	for _, sess := range s.Sessions([]Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}, now) {
		got[sess.Title] = sess.Cwd
	}
	want := map[string]string{
		"In its own folder":                           "/Users/me/shop",
		"Dots, underscores, and spaces become dashes": "/Users/me/my.app_v1 2",
	}
	if len(got) != len(want) {
		t.Fatalf("sessions = %v, want exactly %v", got, want)
	}
	for title, cwd := range want {
		if got[title] != cwd {
			t.Fatalf("session %q has folder %q, want %q (all: %v)", title, got[title], cwd, got)
		}
	}
}

// A Codex log that is a link is not read either.
func TestCodexSessionLogMustBeAPlainFile(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	day := filepath.Join(home, ".codex", "sessions", "2026", "10", "09")
	meta := func(id string) []string {
		return []string{
			`{"type":"session_meta","payload":{"id":"` + id + `","cwd":"/Users/me/api","thread_source":"user"}}`,
			`{"type":"response_item","payload":{"role":"user","content":[{"text":"Add rate limits to the login route"}]}}`,
		}
	}
	writeLog(t, filepath.Join(day, "rollout-real.jsonl"), now.Add(-time.Minute), meta("t-real")...)
	outside := filepath.Join(t.TempDir(), "rollout-out.jsonl")
	writeLog(t, outside, now.Add(-time.Minute), meta("t-out")...)
	if err := os.Symlink(outside, filepath.Join(day, "rollout-linked.jsonl")); err != nil {
		t.Fatal(err)
	}
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	sessions := s.Sessions([]Detection{{ID: "codex", Name: "Codex CLI", Running: []Process{{PID: 2}}}}, now)
	if len(sessions) != 1 || sessions[0].ID != "codex:rollout-real" {
		t.Fatalf("sessions = %+v, want only the plain file's", sessions)
	}
}
