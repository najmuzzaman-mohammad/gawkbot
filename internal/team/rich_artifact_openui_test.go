package team

import (
	"bytes"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/openuiartifact"
)

const validOpenUIArtifact = `root = Stack([title, metric])
title = Heading("Launch review", "1")
metric = Metric("Readiness", "82%", "Two blockers remain", "warning")`

func TestNewRichArtifactCreatesVersionedOpenUIArtifact(t *testing.T) {
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	req := RichArtifactCreateRequest{
		Slug:       "pm",
		Title:      "Launch\nreview",
		Summary:    "Two\nblocking risks",
		OpenUILang: validOpenUIArtifact,
	}

	first, content, err := newRichArtifact(req, now)
	if err != nil {
		t.Fatalf("newRichArtifact: %v", err)
	}
	second, _, err := newRichArtifact(req, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("newRichArtifact retry: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("deterministic id changed across retry: %s != %s", first.ID, second.ID)
	}
	if content != validOpenUIArtifact || first.Representation != richArtifactRepresentationOpenUI {
		t.Fatalf("unexpected OpenUI artifact: %+v", first)
	}
	if first.ContentPath != richArtifactOpenUIPath(first.ID) || first.HTMLPath != "" {
		t.Fatalf("unexpected body paths: content=%q html=%q", first.ContentPath, first.HTMLPath)
	}
	if first.OpenUIVersion != openuiartifact.Version || first.OpenUILibraryHash != openuiartifact.LibraryHash {
		t.Fatalf("missing OpenUI contract: %+v", first)
	}
	if first.Title != "Launch review" || first.Summary != "Two blocking risks" {
		t.Fatalf("metadata was not normalized: title=%q summary=%q", first.Title, first.Summary)
	}
}

func TestRichArtifactOpenUIIDUsesUnambiguousCanonicalTuple(t *testing.T) {
	left := richArtifactOpenUIID("pm", "Title", "root = Stack([])", "", "", "a\x00b", "c", nil)
	right := richArtifactOpenUIID("pm", "Title", "root = Stack([])", "", "", "a", "b\x00c", nil)
	if left == right {
		t.Fatalf("canonical OpenUI IDs collided: %s", left)
	}
}

func TestValidateRichArtifactOpenUIPolicyRejectsActiveFeatures(t *testing.T) {
	for name, source := range map[string]string{
		"query whitespace":    validOpenUIArtifact + "\n" + `query = Query ("tool", {}, "fallback", 1)`,
		"mutation whitespace": validOpenUIArtifact + "\n" + `mutation = Mutation ("tool", {})`,
		"action whitespace":   validOpenUIArtifact + "\n" + `action = @OpenUrl ("target")`,
		"state":               validOpenUIArtifact + "\n" + `$value = "state"`,
		"url":                 validOpenUIArtifact + "\n" + `extra = Text("https://example.test")`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateRichArtifactOpenUIPolicy(source); err == nil {
				t.Fatalf("expected %q to be rejected", name)
			}
		})
	}
	if err := validateRichArtifactOpenUIPolicy(validOpenUIArtifact + "\n" + `extra = Text("Query( is displayed as text")`); err != nil {
		t.Fatalf("plain display text should not be treated as active syntax: %v", err)
	}
}

func TestRichArtifactBodyPathRejectsMixedAndTraversingMetadata(t *testing.T) {
	artifact, _, err := newRichArtifact(RichArtifactCreateRequest{
		Slug:       "pm",
		Title:      "Review",
		OpenUILang: validOpenUIArtifact,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}

	for name, mutate := range map[string]func(*RichArtifact){
		"traversal":              func(a *RichArtifact) { a.ContentPath = "../../secret" },
		"mixed html":             func(a *RichArtifact) { a.HTMLPath = richArtifactHTMLPath(a.ID) },
		"unknown representation": func(a *RichArtifact) { a.Representation = "future" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := artifact
			mutate(&candidate)
			if _, err := richArtifactBodyPath(candidate); err == nil {
				t.Fatal("expected corrupt metadata to fail")
			}
		})
	}
}

func TestDecodeRichArtifactCreateRequestIsBoundedStrictAndUTF8Safe(t *testing.T) {
	tests := []struct {
		name string
		body []byte
	}{
		{name: "duplicate", body: []byte(`{"slug":"pm","slug":"ceo","openui_lang":"root = Stack([])"}`)},
		{name: "unknown", body: []byte(`{"slug":"pm","surprise":true,"openui_lang":"root = Stack([])"}`)},
		{name: "trailing", body: []byte(`{"slug":"pm","openui_lang":"root = Stack([])"} {}`)},
		{name: "invalid utf8", body: append([]byte(`{"slug":"`), 0xff, '"', '}')},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest("POST", "/visual-artifacts", bytes.NewReader(tc.body))
			var dst RichArtifactCreateRequest
			if status, err := decodeRichArtifactCreateRequest(recorder, request, &dst); err == nil || status == 0 {
				t.Fatalf("expected strict decode failure, got status=%d dst=%+v", status, dst)
			}
		})
	}

	tooLarge := strings.Repeat("x", richArtifactMaxOpenUIBytes+richArtifactRequestMetadataAllowance+1)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/visual-artifacts", strings.NewReader(tooLarge))
	var dst RichArtifactCreateRequest
	status, err := decodeRichArtifactCreateRequest(recorder, request, &dst)
	if err == nil || status != 413 {
		t.Fatalf("oversize status=%d err=%v, want 413", status, err)
	}
}

func TestDecodeRichArtifactPromotionRequestIsBoundedAndStrict(t *testing.T) {
	for _, body := range []string{
		`{"target_wiki_path":"team/a.md","mode":"create","mode":"replace"}`,
		`{"target_wiki_path":"team/a.md","unknown":true}`,
		`{"target_wiki_path":"team/a.md"} {}`,
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("POST", "/visual-artifacts/ra_0123456789abcdef/promote", strings.NewReader(body))
		var dst RichArtifactPromoteRequest
		if status, err := decodeRichArtifactJSONRequest(recorder, request, &dst, richArtifactMaxPromotionBytes); err == nil || status == 0 {
			t.Fatalf("expected strict promotion decode failure for %q", body)
		}
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/visual-artifacts/ra_0123456789abcdef/promote", strings.NewReader(strings.Repeat("x", richArtifactMaxPromotionBytes+1)))
	var dst RichArtifactPromoteRequest
	if status, err := decodeRichArtifactJSONRequest(recorder, request, &dst, richArtifactMaxPromotionBytes); err == nil || status != 413 {
		t.Fatalf("expected oversized promotion to return 413, got status=%d err=%v", status, err)
	}
}
