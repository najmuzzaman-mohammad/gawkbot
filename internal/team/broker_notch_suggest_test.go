package team

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// stubNotchSuggest runs the suggestion worker inline with fn as the model.
func stubNotchSuggest(t *testing.T, fn func(ctx context.Context, system, user string) (string, error)) {
	t.Helper()
	prevFn, prevGo := notchSuggestFn, notchSuggestGo
	notchSuggestFn = func(ctx context.Context, _ string, system, user string) (string, error) {
		return fn(ctx, system, user)
	}
	notchSuggestGo = func(run func()) { run() }
	t.Cleanup(func() { notchSuggestFn, notchSuggestGo = prevFn, prevGo })
}

const twoSuggestions = `Sure: {"suggestions":[
  {"label":"Ship it","reply":"Looks good, merge it and watch CI."},
  {"label":"Add a test first","reply":"Add a regression test for the login bug, then merge."}
]}`

func TestNotchSuggestionsAreWrittenOnceAndRecommendedFirst(t *testing.T) {
	calls := 0
	var shown string
	stubNotchSuggest(t, func(_ context.Context, _ string, user string) (string, error) {
		calls++
		shown = user
		return twoSuggestions, nil
	})
	b := newTestBroker(t)
	now := time.Now()
	card := notchAttention{
		ID: "finished:eng@1", Kind: "finished", From: "eng", FromName: "Eng",
		Recap: &notchRecap{Asked: "Fix the login bug", Reply: "Fixed it. Want me to merge?"},
	}
	// The first read asks for them (the stub answers inline); the next
	// read is served from memory.
	first := b.withNotchSuggestions(notchState{Attention: []notchAttention{card}}, true, "codex", now)
	if first.Attention[0].Suggestions != nil {
		t.Fatalf("the read that asked already had suggestions: %+v", first.Attention[0])
	}
	state := b.withNotchSuggestions(notchState{Attention: []notchAttention{card}}, true, "codex", now)
	got := state.Attention[0].Suggestions
	if len(got) != 2 || got[0].Label != "Ship it" || got[1].Reply != "Add a regression test for the login bug, then merge." {
		t.Fatalf("suggestions = %+v", got)
	}
	if calls != 1 {
		t.Fatalf("model called %d times, want once per card", calls)
	}
	if !strings.Contains(shown, "Fix the login bug") || !strings.Contains(shown, "Want me to merge?") {
		t.Fatalf("model was not shown the recap: %q", shown)
	}
}

func TestNotchSuggestionsSkipSecretsOptionsAndOtherViewers(t *testing.T) {
	calls := 0
	stubNotchSuggest(t, func(context.Context, string, string) (string, error) {
		calls++
		return twoSuggestions, nil
	})
	b := newTestBroker(t)
	now := time.Now()
	secret := notchAttention{ID: "r1", Question: "Paste the API key", secret: true}
	options := notchAttention{ID: "r2", Question: "Ship?", Options: []notchOption{{ID: "yes", Label: "Yes"}}}
	words := notchAttention{ID: "r3", Question: "Which customer should I call first?"}

	state := b.withNotchSuggestions(notchState{Attention: []notchAttention{words}}, false, "codex", now)
	if calls != 0 || state.Attention[0].Suggestions != nil {
		t.Fatalf("a joined human's notch asked the model (%d calls)", calls)
	}
	state = b.withNotchSuggestions(notchState{Attention: []notchAttention{secret, options, words}}, true, "codex", now)
	if calls != 1 {
		t.Fatalf("model called %d times, want only for the question asked in words", calls)
	}
	if state.Attention[0].Suggestions != nil || state.Attention[1].Suggestions != nil {
		t.Fatalf("suggested for a secret or an optioned question: %+v", state.Attention)
	}
}

func TestNotchSuggestionsWaitAfterAFailedCall(t *testing.T) {
	calls := 0
	stubNotchSuggest(t, func(context.Context, string, string) (string, error) {
		calls++
		return "", errors.New("rate limited")
	})
	b := newTestBroker(t)
	card := notchAttention{ID: "finished:eng@1", Recap: &notchRecap{Reply: "Done."}}
	now := time.Now()
	b.withNotchSuggestions(notchState{Attention: []notchAttention{card}}, true, "codex", now)
	b.withNotchSuggestions(notchState{Attention: []notchAttention{card}}, true, "codex", now.Add(time.Minute))
	if calls != 1 {
		t.Fatalf("retried within the wait: %d calls", calls)
	}
	b.withNotchSuggestions(notchState{Attention: []notchAttention{card}}, true, "codex", now.Add(notchSuggestRetry+time.Second))
	if calls != 2 {
		t.Fatalf("never retried after the wait: %d calls", calls)
	}
}

func TestParseNotchSuggestionsKeepsOnlySendableReplies(t *testing.T) {
	long := strings.Repeat("word ", 80)
	out := `{"suggestions":[
	  {"label":"Run it","reply":"/clear"},
	  {"label":"Shell","reply":"!rm -rf ."},
	  {"label":"Too long","reply":"` + long + `"},
	  {"label":"","reply":"No label"},
	  {"label":"Merge","reply":"Merge it.\u0007"},
	  {"label":"Merge again","reply":"merge it."},
	  {"label":"Wait","reply":"Hold off until Monday."}
	]}`
	got, ok := parseNotchSuggestions(out)
	if !ok || len(got) != 2 || got[0].Reply != "Merge it." || got[1].Label != "Wait" {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
	if _, ok := parseNotchSuggestions(`{"suggestions":[{"label":"One","reply":"Only one."}]}`); ok {
		t.Fatal("a single suggestion is not a choice")
	}
	if _, ok := parseNotchSuggestions("I cannot help with that."); ok {
		t.Fatal("prose was taken for suggestions")
	}
}

func TestNotchSuggestionsRunOnTheChiefOfStaffsRuntime(t *testing.T) {
	var kinds []string
	prevFn, prevGo := notchSuggestFn, notchSuggestGo
	notchSuggestFn = func(_ context.Context, kind, _, _ string) (string, error) {
		kinds = append(kinds, kind)
		return twoSuggestions, nil
	}
	notchSuggestGo = func(run func()) { run() }
	t.Cleanup(func() { notchSuggestFn, notchSuggestGo = prevFn, prevGo })

	b := newTestBroker(t)
	now := time.Now()
	defaults := runtimeDefaults{Kind: "claude-code"}
	b.mu.Lock()
	lead := officeLeadSlugFrom(b.members)
	i := b.memberIndex[lead]
	b.members[i].Provider.Kind = "opencode"
	bound := b.notchLeadKindLocked(lead, defaults)
	b.members[i].Provider.Kind = ""
	unbound := b.notchLeadKindLocked(lead, defaults)
	none := b.notchLeadKindLocked("nobody", defaults)
	b.mu.Unlock()
	if bound != "opencode" || unbound != "claude-code" || none != "" {
		t.Fatalf("lead kind: bound=%q unbound=%q none=%q", bound, unbound, none)
	}

	card := notchAttention{ID: "finished:eng@1", Recap: &notchRecap{Reply: "Done. Merge?"}}
	b.withNotchSuggestions(notchState{Attention: []notchAttention{card}}, true, bound, now)
	if len(kinds) != 1 || kinds[0] != "opencode" {
		t.Fatalf("suggestions ran on %v, want the lead's opencode", kinds)
	}
	// No lead to run them on: nothing is called.
	other := notchAttention{ID: "finished:ops@1", Recap: &notchRecap{Reply: "Done."}}
	b.withNotchSuggestions(notchState{Attention: []notchAttention{other}}, true, "", now)
	if len(kinds) != 1 {
		t.Fatalf("called with no lead runtime: %v", kinds)
	}
}

func TestNotchSuggestNeverFallsBackToAnotherTool(t *testing.T) {
	if _, err := notchSuggestFn(context.Background(), "no-such-runtime", "s", "u"); !errors.Is(err, errNotchSuggestNoOneShot) {
		t.Fatalf("err = %v, want errNotchSuggestNoOneShot", err)
	}
}

func TestNotchSuggestionsSurviveARestart(t *testing.T) {
	calls := 0
	stubNotchSuggest(t, func(context.Context, string, string) (string, error) {
		calls++
		return twoSuggestions, nil
	})
	b := newTestBroker(t)
	card := notchAttention{ID: "finished:eng@1", Recap: &notchRecap{Reply: "Done. Merge?"}}
	now := time.Now()
	b.withNotchSuggestions(notchState{Attention: []notchAttention{card}}, true, "codex", now)

	again := NewBrokerAt(b.statePath)
	state := again.withNotchSuggestions(notchState{Attention: []notchAttention{card}}, true, "codex", now)
	if calls != 1 {
		t.Fatalf("asked again after a restart: %d calls", calls)
	}
	if got := state.Attention[0].Suggestions; len(got) != 2 || got[0].Label != "Ship it" {
		t.Fatalf("restored suggestions = %+v", got)
	}
}

func TestNotchSuggestionsSayWhileTheyAreBeingWritten(t *testing.T) {
	prevGo := notchSuggestGo
	var started []func()
	notchSuggestGo = func(run func()) { started = append(started, run) }
	t.Cleanup(func() { notchSuggestGo = prevGo })
	stubFn := notchSuggestFn
	notchSuggestFn = func(context.Context, string, string, string) (string, error) { return twoSuggestions, nil }
	t.Cleanup(func() { notchSuggestFn = stubFn })

	b := newTestBroker(t)
	now := time.Now()
	cards := []notchAttention{
		{ID: "finished:a@1", Recap: &notchRecap{Reply: "A done."}},
		{ID: "finished:b@1", Recap: &notchRecap{Reply: "B done."}},
		{ID: "finished:c@1", Recap: &notchRecap{Reply: "C done."}},
	}
	state := b.withNotchSuggestions(notchState{Attention: cards}, true, "codex", now)
	for _, c := range state.Attention {
		if !c.SuggestionsPending || c.Suggestions != nil {
			t.Fatalf("card %s: pending=%v suggestions=%v", c.ID, c.SuggestionsPending, c.Suggestions)
		}
	}
	if len(started) != notchSuggestWorkers {
		t.Fatalf("started %d workers for 3 cards, want %d", len(started), notchSuggestWorkers)
	}
	// A second read starts no more while both are busy.
	b.withNotchSuggestions(notchState{Attention: cards}, true, "codex", now)
	if len(started) != notchSuggestWorkers {
		t.Fatalf("started %d workers, want still %d", len(started), notchSuggestWorkers)
	}
	for _, run := range started {
		run()
	}
	state = b.withNotchSuggestions(notchState{Attention: cards}, true, "codex", now)
	for _, c := range state.Attention {
		if c.SuggestionsPending || len(c.Suggestions) != 2 {
			t.Fatalf("card %s after the workers: pending=%v n=%d", c.ID, c.SuggestionsPending, len(c.Suggestions))
		}
	}
}

func TestNotchSuggestionsAreNeverWrittenForAFinishedTurn(t *testing.T) {
	calls := 0
	stubNotchSuggest(t, func(_ context.Context, _ string, _ string) (string, error) {
		calls++
		return twoSuggestions, nil
	})
	b := newTestBroker(t)
	now := time.Now()
	card := notchAttention{
		ID: "finished:cc-1@1", Kind: "finished", From: "cc-1", FromName: "A session",
		Recap: &notchRecap{Asked: "Fix the login bug", Reply: "Fixed it. Want me to merge?"},
	}
	for i := 0; i < 2; i++ {
		state := b.withNotchSuggestions(notchState{Finished: []notchAttention{card}}, true, "codex", now)
		if state.Finished[0].Suggestions != nil || state.Finished[0].SuggestionsPending {
			t.Fatalf("a finished turn got replies: %+v", state.Finished[0])
		}
	}
	if calls != 0 {
		t.Fatalf("model called %d times for a finished turn, want none", calls)
	}
}
