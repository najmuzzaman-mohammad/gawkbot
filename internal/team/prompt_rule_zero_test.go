package team

import (
	"strings"
	"testing"
)

// TestRuleZeroSeparatesQuestionsFromWork pins the fix for bot over-ceremony.
//
// The founder asked @designer a one-line question in #general and got "I'll
// load the tools I need, then scope this as an Issue and investigate" followed
// by seventy seconds of Bash — for something answerable in a sentence.
//
// The cause was RULE ZERO contradicting itself. It opened with "Any work the
// human asks for gets an Issue. No exceptions." and only fourteen lines later
// admitted that pure chat needs no Issue. The absolute at the top won. Worse,
// the exception's test was "would this need any tool call beyond broadcast?",
// which fails the common case: answering "is dark mode broken?" honestly means
// reading a file, so the bot concluded it was work and filed an Issue.
//
// The prompt now splits on INTENT — does the human want an answer, or do they
// want something to change — and says outright that investigating in order to
// answer is still answering.
func TestRuleZeroSeparatesQuestionsFromWork(t *testing.T) {
	p := ruleZeroBlock()

	if strings.Contains(p, "No exceptions.") {
		t.Error("RULE ZERO must not claim 'No exceptions' while also carving out questions — that contradiction is what made bots file Issues for chat")
	}

	for _, want := range []string{
		"A QUESTION wants an answer",
		"investigating in order to answer is still answering",
		"WORK wants something to change or be produced",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("RULE ZERO must carry the question/work split; missing %q", want)
		}
	}

	// The distinction has to be stated BEFORE the create-an-Issue mandate,
	// because the bot reads top-down and the first absolute it meets wins.
	split := strings.Index(p, "A QUESTION wants an answer")
	mandate := strings.Index(p, "your FIRST tool call MUST be team_task action=create")
	if split < 0 || mandate < 0 {
		t.Fatalf("expected both the split and the mandate in RULE ZERO")
	}
	if split > mandate {
		t.Error("the question/work split must come BEFORE the Issue mandate, or the mandate reads as unconditional")
	}
}

// TestRuleZeroBansNarrationPreamble pins the second half of the same fix: the
// bot announced its process before doing anything. The human already sees a
// live status feed, so the preamble is pure latency.
func TestRuleZeroBansNarrationPreamble(t *testing.T) {
	p := ruleZeroBlock()
	if !strings.Contains(p, "No narration tax") {
		t.Error("RULE ZERO must ban the 'here is what I am about to do' preamble")
	}
	if !strings.Contains(p, "Lead with the answer or the action") {
		t.Error("RULE ZERO must tell the bot what to do instead of narrating")
	}
}
