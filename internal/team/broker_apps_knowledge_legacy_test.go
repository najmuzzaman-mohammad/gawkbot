package team

// Legacy knowledge preservation: a workspace upgrading from the office-era
// product keeps its wiki articles (wiki/team/**.md) and per-bot notebook
// notes (wiki/bots/<bot>/notebook/*.md) as Knowledge pages, verbatim,
// appended to every knowledge response.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// seedLegacyWiki writes a small office-era wiki tree under home/.wuphf/wiki.
func seedLegacyWiki(t *testing.T, home string) {
	t.Helper()
	write := func(rel, content string) {
		t.Helper()
		path := filepath.Join(home, ".wuphf", "wiki", rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", rel, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	write("team/research/rag-brief.md", strings.Join([]string{
		"---",
		`title: "RAG retrieval quality brief"`,
		"owner: rag-engineer",
		"---",
		"",
		"Hybrid search beats pure semantic retrieval in our benchmarks.",
		"",
		"## Findings",
		"",
		"BM25 plus embeddings fused with RRF improved recall by 18%.",
		"",
		"Rank-sensitive metrics matter more than hit rate.",
		"",
		"## Next steps",
		"",
		"Wire the reranker into slice 2.",
	}, "\n"))
	write("team/decisions/OFFICE-59.md", "# Adopt RRF fusion\n\nDecision: fuse BM25 and semantic scores with RRF.\n")
	write("team/.obsidian/app.json", "{}")
	write("agents/rag-engineer/notebook/papers-survey.md", "# RAG papers survey\n\nNotes on 2024-2025 retrieval techniques.\n")
	write("agents/rag-engineer/notebook/.gitkeep", "")
	write("agents/outbound/notebook/empty-note.md", "\n\n")
	// A visual artifact: the sanitized HTML view of the survey note, promoted
	// into the research brief — its sidecar names both owner pages.
	write("wiki/visual-artifacts/ra_abc123.html", "<h1>Survey figure</h1>")
	write("wiki/visual-artifacts/ra_abc123.json", `{
		"title": "RAG survey figure",
		"htmlPath": "wiki/visual-artifacts/ra_abc123.html",
		"sourceMarkdownPath": "agents/rag-engineer/notebook/papers-survey.md",
		"promotedWikiPath": "team/research/rag-brief.md"
	}`)
	// A sidecar whose file is GONE must attach nowhere.
	write("wiki/visual-artifacts/ra_gone.json", `{
		"title": "Deleted view",
		"htmlPath": "wiki/visual-artifacts/ra_gone.html",
		"sourceMarkdownPath": "agents/rag-engineer/notebook/papers-survey.md"
	}`)
}

func TestLoadLegacyKnowledgePages(t *testing.T) {
	home := t.TempDir()
	seedLegacyWiki(t, home)
	pages := loadLegacyKnowledgePages(filepath.Join(home, ".wuphf", "wiki"))

	if len(pages) != 3 {
		titles := make([]string, 0, len(pages))
		for _, p := range pages {
			titles = append(titles, p.Category+" / "+p.Title)
		}
		t.Fatalf("pages = %d (%v), want 3 (2 wiki + 1 notebook; .obsidian, .gitkeep, empty skipped)", len(pages), titles)
	}

	byID := map[string]appKnowledgePage{}
	for _, p := range pages {
		byID[p.ID] = p
	}

	brief, ok := byID["legacy-wiki-"+slugifyKnowledgeID("research/rag-brief.md")]
	if !ok {
		t.Fatalf("missing wiki brief page; got %v", byID)
	}
	// Frontmatter title wins; the folder is the category; content is verbatim.
	if brief.Title != "RAG retrieval quality brief" {
		t.Fatalf("brief title = %q", brief.Title)
	}
	if brief.Category != "Team wiki · research" {
		t.Fatalf("brief category = %q", brief.Category)
	}
	if !strings.Contains(brief.Lead, "Hybrid search beats pure semantic") {
		t.Fatalf("brief lead = %q", brief.Lead)
	}
	if len(brief.Sections) != 2 || brief.Sections[0].Heading != "Findings" || len(brief.Sections[0].Paras) != 2 {
		t.Fatalf("brief sections = %+v", brief.Sections)
	}
	if brief.Summary == "" || brief.References == nil || brief.Infobox == nil {
		t.Fatalf("brief must have a summary and non-nil slices: %+v", brief)
	}
	if len(brief.Categories) == 0 || brief.Categories[0] != legacyKnowledgeCategoryTag {
		t.Fatalf("brief categories = %v", brief.Categories)
	}

	decision, ok := byID["legacy-wiki-"+slugifyKnowledgeID("decisions/OFFICE-59.md")]
	if !ok || decision.Title != "Adopt RRF fusion" {
		t.Fatalf("decision page = %+v ok=%v (H1 must become the title)", decision, ok)
	}

	// Notebook notes now share their id scheme with the per-bot Knowledge
	// surface (loadBotNotebookPages), so the "legacy-" qualifier is gone: the
	// same note is the same page whichever surface reads it.
	note, ok := byID["notebook-"+slugifyKnowledgeID("rag-engineer-papers-survey.md")]
	if !ok || note.Category != "Notebook · rag-engineer" || note.Title != "RAG papers survey" {
		t.Fatalf("notebook page = %+v ok=%v", note, ok)
	}
	if note.Bot != "rag-engineer" || note.SourcePath != "agents/rag-engineer/notebook/papers-survey.md" {
		t.Fatalf("notebook page provenance = bot %q source %q, want the owning bot and its note path",
			note.Bot, note.SourcePath)
	}

	// The visual artifact attaches to BOTH owner pages its sidecar names —
	// the source notebook note and the promoted wiki article.
	wantURL := legacyArtifactURLPrefix + "ra_abc123.html"
	for _, p := range []appKnowledgePage{brief, note} {
		if len(p.Artifacts) != 1 || p.Artifacts[0].URL != wantURL {
			t.Fatalf("%s artifacts = %+v, want the ra_abc123 html view", p.ID, p.Artifacts)
		}
		if p.Artifacts[0].Kind != "html" || p.Artifacts[0].Title != "RAG survey figure" {
			t.Fatalf("%s artifact meta = %+v", p.ID, p.Artifacts[0])
		}
	}
	// A sidecar whose file is gone attaches nowhere (note would have had 2).
	if decision.Artifacts != nil {
		t.Fatalf("decision page must carry no artifacts, got %+v", decision.Artifacts)
	}
}

// TestLegacyKnowledgeArtifactEndpoint locks the artifact route's contract: the
// file serves sandboxed with the right content type, and the filename alphabet
// is the whole trust boundary — traversal and non-artifact extensions 404.
func TestLegacyKnowledgeArtifactEndpoint(t *testing.T) {
	home := t.TempDir()
	t.Setenv("WUPHF_RUNTIME_HOME", home)
	seedLegacyWiki(t, home)

	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()
	base := fmt.Sprintf("http://%s", b.Addr())

	get := func(path string, auth bool) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, base+path, nil)
		if auth {
			req.Header.Set("Authorization", "Bearer "+b.Token())
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		return res
	}

	res := get(legacyArtifactURLPrefix+"ra_abc123.html", true)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("artifact GET = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q", ct)
	}
	// Defense in depth: the response document is sandboxed even when opened
	// directly, independent of the FE iframe sandbox. Never loosen silently.
	if csp := res.Header.Get("Content-Security-Policy"); csp != "sandbox" {
		t.Fatalf("CSP = %q, want sandbox", csp)
	}

	if res := get(legacyArtifactURLPrefix+"ra_abc123.html", false); res.StatusCode == http.StatusOK {
		t.Fatalf("unauthenticated artifact GET must not serve, got %d", res.StatusCode)
	}
	for _, bad := range []string{"..%2f..%2fconfig.json", ".hidden.html", "ra_abc123.json", "nope.html"} {
		if res := get(legacyArtifactURLPrefix+bad, true); res.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %q = %d, want 404", bad, res.StatusCode)
		}
	}
}

// writeLegacyPage writes one standalone markdown file and loads it as a page.
func writeLegacyPage(t *testing.T, name, content string) (appKnowledgePage, bool) {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return legacyPageFromFile(path, "legacy-wiki-"+name, "Team wiki")
}

// TestLegacyPageStripsHTMLComments — regression for the QA finding where the
// previous product's machine-metadata comment (the wuphf:entity-article
// marker) rendered as visible body text. All HTML comments are metadata and
// must be stripped from the served page; the surrounding content stays intact.
func TestLegacyPageStripsHTMLComments(t *testing.T) {
	page, ok := writeLegacyPage(t, "final-rag.md", strings.Join([]string{
		"Before the marker.",
		"",
		"<!-- wuphf:entity-article — generated from the team knowledge graph",
		"(fact log + entity graph); regenerated deterministically when completed",
		"tasks record new facts. The generated body is fully managed. -->",
		"",
		"After the marker.",
		"",
		"## Details",
		"",
		"Inline <!-- machine note --> text survives around the comment.",
	}, "\n"))
	if !ok {
		t.Fatalf("page not loaded")
	}
	// No H1 in the body, so the slug fallback still names the page.
	if page.Title != "Final rag" {
		t.Fatalf("title = %q, want slug fallback %q", page.Title, "Final rag")
	}
	for _, leaked := range []string{"<!--", "-->", "wuphf:entity-article", "machine note"} {
		if strings.Contains(page.Lead, leaked) {
			t.Fatalf("lead leaks comment metadata %q: %q", leaked, page.Lead)
		}
		for _, s := range page.Sections {
			if strings.Contains(strings.Join(s.Paras, "\n"), leaked) {
				t.Fatalf("section %q leaks comment metadata %q: %+v", s.Heading, leaked, s.Paras)
			}
		}
	}
	for _, kept := range []string{"Before the marker.", "After the marker."} {
		if !strings.Contains(page.Lead, kept) {
			t.Fatalf("lead lost surrounding content %q: %q", kept, page.Lead)
		}
	}
	if len(page.Sections) != 1 || page.Sections[0].Heading != "Details" ||
		!strings.Contains(strings.Join(page.Sections[0].Paras, "\n"), "text survives around the comment") {
		t.Fatalf("sections = %+v, want Details with its text intact", page.Sections)
	}
}

// TestLegacyPageTitlePrefersFirstH1 — regression for slug-mangled titles like
// "Add diana". The real preserved entity articles carry frontmatter (with no
// title:) plus a machine comment before the H1; the first H1 in the body is
// the title, never the prettified filename slug.
func TestLegacyPageTitlePrefersFirstH1(t *testing.T) {
	page, ok := writeLegacyPage(t, "add-diana.md", strings.Join([]string{
		"---",
		"last_synthesized_sha: 5529675",
		"last_synthesized_ts: 2026-06-16T14:35:19Z",
		"fact_count_at_synthesis: 1",
		"---",
		"",
		"<!-- wuphf:entity-article — generated from the team knowledge graph (fact log + entity graph); regenerated deterministically when completed tasks record new facts. The generated body is fully managed: human edits are detected via last_human_edit_ts and preserved by moving the generated article into a managed block. -->",
		"",
		"# Add Diana",
		"",
		"**Add Diana** is a company in the team knowledge graph, with 1 recorded fact from 1 completed task.",
	}, "\n"))
	if !ok {
		t.Fatalf("page not loaded")
	}
	if page.Title != "Add Diana" {
		t.Fatalf("title = %q, want %q from the body H1", page.Title, "Add Diana")
	}
	if strings.Contains(page.Lead, "<!--") || strings.Contains(page.Lead, "# Add Diana") {
		t.Fatalf("lead must carry neither the comment nor the consumed H1: %q", page.Lead)
	}
	if !strings.Contains(page.Lead, "**Add Diana** is a company") {
		t.Fatalf("lead lost the article body: %q", page.Lead)
	}

	// The first H1 also wins when plain prose precedes it.
	page, ok = writeLegacyPage(t, "hubspot-mql.md", "Imported note.\n\n# HubSpot MQL definition\n\nWhat counts as an MQL.\n")
	if !ok {
		t.Fatalf("page not loaded")
	}
	if page.Title != "HubSpot MQL definition" {
		t.Fatalf("title = %q, want the first H1 even after prose", page.Title)
	}
}

func TestLoadLegacyKnowledgePagesMissingTree(t *testing.T) {
	if pages := loadLegacyKnowledgePages(filepath.Join(t.TempDir(), "nope")); len(pages) != 0 {
		t.Fatalf("missing tree must yield no pages, got %d", len(pages))
	}
}

// TestAppKnowledgeIncludesLegacyPages locks the endpoint contract: the
// preserved pages append to the response even when synthesis is unavailable —
// an upgrading user sees their old wiki/notebooks the moment they open the
// Knowledge tab, provider or no provider.
func TestAppKnowledgeIncludesLegacyPages(t *testing.T) {
	home := t.TempDir()
	t.Setenv("WUPHF_RUNTIME_HOME", home)
	seedLegacyWiki(t, home)

	b := newTestBroker(t)
	b.knowledgeBrainOverride = newFakeBrain()
	// No provider: synthesis fails, but the legacy pages must still serve.
	withFakeAppsLLM(t, func(context.Context, string, string) (string, error) {
		return "", fmt.Errorf("no provider on this host")
	})
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()
	base := fmt.Sprintf("http://%s", b.Addr())

	regBody, _ := json.Marshal(map[string]any{
		"name": "Upgraded App", "description": "Lives in a workspace with a legacy wiki.",
		"html": validAppHTML,
	})
	created := postAppsAsBot(t, base+"/apps", b.Token(), appBuilderSlug, regBody)
	app, _ := created["app"].(map[string]any)
	id, _ := app["id"].(string)
	if id == "" {
		t.Fatalf("no app id: %v", created)
	}

	status, out := getAppsJSON(t, base+"/apps/"+id+"/knowledge", b.Token())
	if status != http.StatusOK {
		t.Fatalf("GET knowledge: %d", status)
	}
	pages, _ := out["pages"].([]any)
	if len(pages) != 3 {
		t.Fatalf("pages = %d, want the 3 preserved legacy pages", len(pages))
	}
	titles := make([]string, 0, len(pages))
	for _, raw := range pages {
		p, _ := raw.(map[string]any)
		titles = append(titles, fmt.Sprint(p["title"]))
	}
	joined := strings.Join(titles, " | ")
	for _, want := range []string{"RAG retrieval quality brief", "Adopt RRF fusion", "RAG papers survey"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("legacy page %q missing from response: %s", want, joined)
		}
	}
}
