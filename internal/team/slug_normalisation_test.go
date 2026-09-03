package team

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// One table per BEHAVIOUR CLASS, not one test per site. The pre-S3 tranche
// touched ~50 call sites, but they only fail in three distinct ways, and the
// classes are what a reader needs to understand:
//
//	1. the two normalisers must disagree on exactly three inputs, and nowhere
//	   else — every judgement in the tranche rests on that,
//	2. a REFUSAL placed after the normalise never fires (permissive bug),
//	3. a FILTER placed after the normalise never widens (restrictive bug).
//
// Same root cause, opposite symptoms, which is why there is no single
// mechanical fix and why eyeballing the diff does not work.

// TestNormaliserDivergenceIsExactlyThreeCases is the load-bearing test of the
// whole tranche. Every "switch this site to normalizeActorSlug" judgement was
// made on the claim that the two normalisers agree on ordinary bot slugs and
// differ only on empty, a leading "#", and "__". If that claim stops holding,
// the switches become silent behaviour changes on persisted data — so pin it.
func TestNormaliserDivergenceIsExactlyThreeCases(t *testing.T) {
	agree := []string{
		"ceo", "app-builder", "gtm-lead", "founding-engineer",
		"librarian", "designer", "pm", "a", "agent-9",
	}
	for _, in := range agree {
		if got, want := normalizeActorSlug(in), normalizeChannelSlug(in); got != want {
			t.Errorf("ordinary slug %q: actor=%q channel=%q — the two must agree here, "+
				"or every normaliser switch in this tranche is a behaviour change", in, got, want)
		}
	}

	diverge := []struct {
		in      string
		actor   string
		channel string
		why     string
	}{
		{"", "", GeneralChannelSlug, "the laundering bug: empty becomes the lobby"},
		{"   ", "", GeneralChannelSlug, "whitespace-only is the same case"},
		{"#ceo", "#ceo", "ceo", "the channel normaliser strips a leading #"},
		{"a__b", "a--b", "a__b", "the channel normaliser preserves the DM separator"},
	}
	for _, c := range diverge {
		if got := normalizeActorSlug(c.in); got != c.actor {
			t.Errorf("normalizeActorSlug(%q) = %q, want %q (%s)", c.in, got, c.actor, c.why)
		}
		if got := normalizeChannelSlug(c.in); got != c.channel {
			t.Errorf("normalizeChannelSlug(%q) = %q, want %q (%s)", c.in, got, c.channel, c.why)
		}
	}
}

// TestChannelNormaliserLaundersEmptyIntoTheLobby is the single fact the whole
// bug class rests on. Stated once, by name, so that when S3 changes
// normalizeChannelSlug this test says exactly which invariant moved rather
// than a dozen unrelated tests failing mysteriously.
func TestChannelNormaliserLaundersEmptyIntoTheLobby(t *testing.T) {
	for _, in := range []string{"", " ", "\t", "\n", "#"} {
		if got := normalizeChannelSlug(in); got != GeneralChannelSlug {
			t.Fatalf("normalizeChannelSlug(%q) = %q, want %q — "+
				"the pre-S3 tranche's raw-emptiness guards all exist because of this",
				in, got, GeneralChannelSlug)
		}
	}
}

// ── Class 2: a refusal that never fires (permissive) ────────────────────────

// TestRefusalsFireOnEmptyInput covers the B_refuse class: a guard written as
// `if x == "" { refuse }` AFTER `x = normalizeChannelSlug(raw)` is dead,
// because the normaliser never returns "". Each case below is a real site;
// they are grouped because they fail identically, and each asserts the
// REFUSAL rather than a substituted default.
func TestRefusalsFireOnEmptyInput(t *testing.T) {
	t.Run("member mutation rejects a missing slug at the boundary", func(t *testing.T) {
		b := newTestBroker(t)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/office/members",
			strings.NewReader(`{"action":"remove","slug":"  "}`))
		b.handleOfficeMembers(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("got %d, want 400 — a member mutation with no slug used to "+
				"normalise to \"general\" and target a member named after a channel", rec.Code)
		}
	})

	t.Run("bridged member registration rejects a missing slug", func(t *testing.T) {
		b := newTestBroker(t)
		if err := b.EnsureBridgedMember("   ", "Name", "openclaw"); err == nil {
			t.Error("expected an error; an empty bridge slug used to register a member called \"general\"")
		}
	})

	t.Run("bot activity with no bot is dropped, not filed under a channel", func(t *testing.T) {
		b := newTestBroker(t)
		b.UpdateBotActivity(botActivitySnapshot{Slug: "  "})
		b.mu.Lock()
		_, leaked := b.activity[GeneralChannelSlug]
		n := len(b.activity)
		b.mu.Unlock()
		if leaked {
			t.Error("an agentless activity update was recorded against the #general CHANNEL")
		}
		if n != 0 {
			t.Errorf("expected no activity recorded, got %d entries", n)
		}
	})

	t.Run("generated member template rejects an empty slug", func(t *testing.T) {
		if _, err := parseGeneratedMemberTemplate(`{"slug":"  ","name":"X"}`); err == nil {
			t.Error("expected an error; an empty generated slug used to mint a bot named \"general\"")
		}
	})

	t.Run("uniqueSlugs drops a blank entry instead of injecting the lobby", func(t *testing.T) {
		got := uniqueSlugs([]string{"ceo", "", "  ", "designer"})
		for _, s := range got {
			if s == GeneralChannelSlug {
				t.Fatalf("a blank member entry became %q: %v — "+
					"#general silently joined the channel as a member", GeneralChannelSlug, got)
			}
		}
		if len(got) != 2 {
			t.Errorf("got %v, want exactly [ceo designer]", got)
		}
	})
}

// ── Class 3: a filter that never widens (restrictive) ───────────────────────

// TestEmptyFilterMeansNoFilter covers the B_filter class, which is the
// inverse failure: a guard written as `if x != "" { narrow }` after the
// normalise can never be false, so "no filter" silently became "filter on
// general" and a list endpoint returned a SUBSET without any error.
//
// These are live user-visible bugs, not flip-time ones: a short list looks
// like a short list, so nobody could have diagnosed it from the outside.
func TestEmptyFilterMeansNoFilter(t *testing.T) {
	t.Run("GET /skills with no channel returns every channel's skills", func(t *testing.T) {
		b := newTestBroker(t)
		b.mu.Lock()
		b.skills = []teamSkill{
			{ID: "s1", Name: "in-general", Channel: GeneralChannelSlug, Status: "active"},
			{ID: "s2", Name: "in-product", Channel: "product", Status: "active"},
			{ID: "s3", Name: "no-channel", Channel: "", Status: "active"},
		}
		b.mu.Unlock()

		rec := httptest.NewRecorder()
		b.handleGetSkills(rec, httptest.NewRequest(http.MethodGet, "/skills", nil))
		body := rec.Body.String()
		for _, want := range []string{"in-general", "in-product", "no-channel"} {
			if !strings.Contains(body, want) {
				t.Errorf("unfiltered /skills omitted %q — it used to return only #general's skills; body=%s", want, body)
			}
		}
	})

	t.Run("an explicit channel filter still narrows", func(t *testing.T) {
		b := newTestBroker(t)
		b.mu.Lock()
		b.skills = []teamSkill{
			{ID: "s1", Name: "in-general", Channel: GeneralChannelSlug, Status: "active"},
			{ID: "s2", Name: "in-product", Channel: "product", Status: "active"},
		}
		b.mu.Unlock()

		rec := httptest.NewRecorder()
		b.handleGetSkills(rec, httptest.NewRequest(http.MethodGet, "/skills?channel=product", nil))
		body := rec.Body.String()
		if !strings.Contains(body, "in-product") {
			t.Error("an explicit filter dropped the matching skill")
		}
		if strings.Contains(body, "in-general") {
			t.Error("an explicit filter leaked a non-matching skill; widening went too far")
		}
	})

	// cancelActiveHumanInterviewsLocked breaks after the first match by design,
	// so the count is always 0 or 1. The behavioural difference the fix makes
	// is therefore about REACH, not volume: with no channel given it must be
	// able to reach an interview that lives outside #general. Before the fix
	// the empty channel normalised to "general" and nothing outside that room
	// was ever a candidate.
	t.Run("cancelling with no channel reaches an interview outside #general", func(t *testing.T) {
		b := newTestBroker(t)
		b.mu.Lock()
		b.requests = []humanInterview{
			{ID: "r1", Kind: "interview", Status: "pending", From: "ceo", Channel: "product", Question: "q1"},
		}
		n := b.cancelActiveHumanInterviewsLocked("human", "done", "", "")
		b.mu.Unlock()
		if n != 1 {
			t.Errorf("cancelled %d — an unfiltered cancel could not reach #product, because "+
				"the empty channel was laundered into \"general\"", n)
		}
	})

	t.Run("an explicit channel still scopes the cancel", func(t *testing.T) {
		b := newTestBroker(t)
		b.mu.Lock()
		b.requests = []humanInterview{
			{ID: "r1", Kind: "interview", Status: "pending", From: "ceo", Channel: "product", Question: "q1"},
		}
		n := b.cancelActiveHumanInterviewsLocked("human", "done", "gtm", "")
		b.mu.Unlock()
		if n != 0 {
			t.Errorf("cancelled %d — an explicit #gtm filter must not touch #product; widening went too far", n)
		}
	})
}

// ── The exception: where the CHANNEL normaliser is the correct one ──────────

// TestDMSlugsRequireTheChannelNormaliser guards the trap running in reverse.
//
// The obvious reading of broker_dm.go is "these take a bot slug, so switch
// them to normalizeActorSlug like everything else". That is catastrophically
// wrong: normalizeChannelSlug's "__" placeholder dance exists precisely to
// preserve the DM separator, and the actor normaliser folds "__" to "--". A
// sweep that "finished the job" here would break DM lookup, DMTargetBot, and
// the canonical-slug migration in one move, and every symptom would look like
// a routing bug rather than a normalisation one.
func TestDMSlugsRequireTheChannelNormaliser(t *testing.T) {
	dm := DMSlugFor("ceo")
	if dm == "" || !strings.Contains(dm, "__") {
		t.Fatalf("DMSlugFor(\"ceo\") = %q, expected a %q-separated pair slug", dm, "__")
	}

	if got := normalizeChannelSlug(dm); got != dm {
		t.Errorf("normalizeChannelSlug(%q) = %q — the channel normaliser MUST round-trip a DM slug", dm, got)
	}
	if got := normalizeActorSlug(dm); got == dm {
		t.Fatalf("normalizeActorSlug(%q) round-tripped; this test can no longer prove the hazard", dm)
	}

	// The consequence, stated as behaviour rather than as string equality: run
	// a DM slug through the actor normaliser and it stops resolving.
	if !IsDMSlug(dm) {
		t.Fatalf("IsDMSlug(%q) = false; fixture is wrong", dm)
	}
	if IsDMSlug(normalizeActorSlug(dm)) {
		t.Error("an actor-normalised DM slug still parsed as a DM — the hazard has moved, re-check broker_dm.go")
	}
	if got := DMTargetBot(normalizeActorSlug(dm)); got == "ceo" {
		t.Error("DMTargetBot survived actor normalisation; re-check the DO-NOT-CHANGE note in broker_dm.go")
	}
}
