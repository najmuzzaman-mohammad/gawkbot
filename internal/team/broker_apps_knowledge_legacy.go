package team

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/nex-crm/wuphf/internal/config"
)

// broker_apps_knowledge_legacy.go — preserve the previous product's wiki
// articles and per-bot notebook notes as Knowledge pages.
//
// The office-era wuphf kept a files-on-disk knowledge base under
// <runtime home>/.wuphf/wiki: team articles in team/<category>/*.md and each
// bot's draft notes in bots/<bot>/notebook/*.md. The operator product
// synthesizes cited pages instead — but an upgrading workspace must not lose
// what it already wrote. Every knowledge response therefore appends the legacy
// pages, preserved VERBATIM (no synthesis, no fabricated citations), under
// "Team wiki · <category>" / "Notebook · <bot>" categories. A workspace
// without a legacy tree contributes nothing.

// legacyKnowledgeMaxPages bounds the payload for enormous legacy trees. The cap
// is logged when hit — never a silent truncation.
const legacyKnowledgeMaxPages = 200

const legacyKnowledgeCategoryTag = "Imported from your previous workspace"

// legacyKnowledgePages loads the legacy tree once per broker; the previous
// product no longer writes to it, so it is immutable for this process's life.
func (b *Broker) legacyKnowledgePages() []appKnowledgePage {
	b.legacyKnowledgeOnce.Do(func() {
		root := filepath.Join(config.RuntimeHomeDir(), ".wuphf", "wiki")
		b.legacyKnowledge = loadLegacyKnowledgePages(root)
		if n := len(b.legacyKnowledge); n > 0 {
			fmt.Fprintf(os.Stderr, "broker: preserved %d legacy wiki/notebook page(s) into Knowledge\n", n)
		}
	})
	return b.legacyKnowledge
}

// loadLegacyKnowledgePages reads team articles and notebook notes from a legacy
// wiki root. A missing root, or one with no markdown, yields nil.
func loadLegacyKnowledgePages(root string) []appKnowledgePage {
	var pages []appKnowledgePage
	// Root-relative source path (e.g. "team/research/brief.md") → index into
	// pages, so visual artifacts can attach to the pages they belong to.
	byRel := map[string]int{}

	// Team wiki articles: team/<category>/**.md (the category is the first
	// folder under team/; root-level files read as plain "Team wiki").
	// A walk error (missing tree, unreadable entry) ends the walk; whatever was
	// collected up to that point is still preserved — this is best-effort
	// archaeology, not a transaction.
	teamRoot := filepath.Join(root, "team")
	_ = filepath.Walk(teamRoot, func(path string, info os.FileInfo, werr error) error {
		if werr != nil {
			return werr
		}
		if info.IsDir() {
			// Editor/system dirs (.obsidian, .git) are not articles.
			if strings.HasPrefix(info.Name(), ".") && path != teamRoot {
				return filepath.SkipDir
			}
			return nil
		}
		// Walk only yields paths under teamRoot, so a prefix trim IS the
		// relative path — no error case to swallow.
		rel := strings.TrimPrefix(path, teamRoot+string(filepath.Separator))
		category := "Team wiki"
		if dir := filepath.Dir(rel); dir != "." {
			category = "Team wiki · " + strings.SplitN(filepath.ToSlash(dir), "/", 2)[0]
		}
		if page, ok := legacyPageFromFile(path, "legacy-wiki-"+slugifyKnowledgeID(filepath.ToSlash(rel)), category); ok {
			byRel["team/"+filepath.ToSlash(rel)] = len(pages)
			pages = append(pages, page)
		}
		return nil
	})

	// Notebook notes: bots/<bot>/notebook/*.md — each bot's draft notes,
	// kept under that bot's name. This is the SAME tree the per-bot
	// Knowledge surface reads (broker_agent_knowledge.go); the shared parser
	// lives in loadBotNotebookPages so both callers see identical pages.
	botDirs, _ := os.ReadDir(filepath.Join(root, "agents"))
	for _, botDir := range botDirs {
		if !botDir.IsDir() || strings.HasPrefix(botDir.Name(), ".") {
			continue
		}
		for _, page := range loadBotNotebookPages(root, botDir.Name()) {
			byRel[page.SourcePath] = len(pages)
			pages = append(pages, page)
		}
	}

	attachLegacyArtifacts(root, pages, byRel)

	// Stable order: wiki articles first (the reviewed, promoted knowledge), then
	// notebooks (draft scratch); alphabetical within.
	rank := func(p appKnowledgePage) int {
		if strings.HasPrefix(p.Category, "Team wiki") {
			return 0
		}
		return 1
	}
	sort.Slice(pages, func(i, j int) bool {
		if r1, r2 := rank(pages[i]), rank(pages[j]); r1 != r2 {
			return r1 < r2
		}
		if pages[i].Category != pages[j].Category {
			return pages[i].Category < pages[j].Category
		}
		return pages[i].Title < pages[j].Title
	})
	if len(pages) > legacyKnowledgeMaxPages {
		fmt.Fprintf(os.Stderr, "broker: legacy knowledge capped at %d of %d pages\n", legacyKnowledgeMaxPages, len(pages))
		pages = pages[:legacyKnowledgeMaxPages]
	}
	return pages
}

// ── Visual artifacts: the previous product's HTML briefs and PDFs ─────────────

// legacyArtifactSidecar is the metadata file the previous product wrote next to
// each visual artifact (wiki/visual-artifacts/ra_*.json). The two path fields
// name exactly which pages the artifact belongs to.
type legacyArtifactSidecar struct {
	Title              string `json:"title"`
	HTMLPath           string `json:"htmlPath"`
	PDFPath            string `json:"pdfPath"`
	SourceMarkdownPath string `json:"sourceMarkdownPath"`
	PromotedWikiPath   string `json:"promotedWikiPath"`
}

// legacyArtifactsRelDir is where the previous product kept visual artifacts,
// relative to the legacy wiki root.
const legacyArtifactsRelDir = "wiki/visual-artifacts"

// legacyArtifactURLPrefix is the broker route serving preserved artifact files
// (handleLegacyKnowledgeArtifact). The FE fetches these with auth and renders
// HTML sandboxed / PDFs as downloads.
const legacyArtifactURLPrefix = "/apps/knowledge/legacy-artifacts/"

// attachLegacyArtifacts reads every artifact sidecar and attaches the artifact
// to the pages its metadata names (the source notebook note and the promoted
// wiki article). Artifacts without a parseable sidecar, or whose files are
// gone, attach nowhere — a page never links a view that cannot be served.
func attachLegacyArtifacts(root string, pages []appKnowledgePage, byRel map[string]int) {
	dir := filepath.Join(root, legacyArtifactsRelDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(dir, entry.Name()))
		if readErr != nil {
			continue
		}
		var side legacyArtifactSidecar
		if json.Unmarshal(raw, &side) != nil {
			continue
		}
		for _, rel := range []string{side.HTMLPath, side.PDFPath} {
			file := filepath.Base(strings.TrimSpace(rel))
			if file == "." || file == "" || !legacyArtifactNameRe.MatchString(file) {
				continue
			}
			if _, statErr := os.Stat(filepath.Join(dir, file)); statErr != nil {
				continue
			}
			kind := strings.TrimPrefix(strings.ToLower(filepath.Ext(file)), ".")
			if kind != "html" && kind != "pdf" {
				continue
			}
			title := side.Title
			if title == "" {
				title = humanizeLegacyName(strings.TrimSuffix(file, filepath.Ext(file)))
			}
			art := appKnowledgeArtifact{Title: title, Kind: kind, URL: legacyArtifactURLPrefix + file}
			for _, owner := range []string{side.SourceMarkdownPath, side.PromotedWikiPath} {
				idx, ok := byRel[strings.TrimSpace(owner)]
				if !ok {
					continue
				}
				if hasLegacyArtifact(pages[idx].Artifacts, art.URL) {
					continue
				}
				pages[idx].Artifacts = append(pages[idx].Artifacts, art)
			}
		}
	}
}

func hasLegacyArtifact(list []appKnowledgeArtifact, url string) bool {
	for _, a := range list {
		if a.URL == url {
			return true
		}
	}
	return false
}

// legacyArtifactNameRe is the whole trust boundary for the artifact file route:
// a bare filename, no separators, no leading dot — path traversal cannot be
// expressed in this alphabet.
var legacyArtifactNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// handleLegacyKnowledgeArtifact serves one preserved visual-artifact file. The
// HTML was sanitized by the previous product, but we do not lean on that: the
// response carries `CSP: sandbox` and the FE additionally renders it inside a
// fully sandboxed iframe (no scripts, no navigation, no same-origin).
func (b *Broker) handleLegacyKnowledgeArtifact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, legacyArtifactURLPrefix)
	ext := strings.ToLower(filepath.Ext(name))
	if !legacyArtifactNameRe.MatchString(name) || (ext != ".html" && ext != ".pdf") {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	path := filepath.Join(config.RuntimeHomeDir(), ".wuphf", "wiki", legacyArtifactsRelDir, name)
	raw, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if ext == ".pdf" {
		w.Header().Set("Content-Type", "application/pdf")
	} else {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(raw)
}

// legacyPageFromFile turns one legacy markdown file into a verbatim Knowledge
// page. Non-markdown, placeholder, and empty files report ok=false.
func legacyPageFromFile(path, id, category string) (appKnowledgePage, bool) {
	base := filepath.Base(path)
	if strings.HasPrefix(base, ".") || !strings.EqualFold(filepath.Ext(base), ".md") {
		return appKnowledgePage{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return appKnowledgePage{}, false
	}
	title, lead, sections := parseLegacyMarkdown(string(raw))
	if title == "" {
		title = humanizeLegacyName(strings.TrimSuffix(base, filepath.Ext(base)))
	}
	if lead == "" && len(sections) == 0 {
		return appKnowledgePage{}, false // .gitkeep-grade emptiness
	}
	updated := ""
	if info, statErr := os.Stat(path); statErr == nil {
		updated = "Preserved from your previous workspace · " + info.ModTime().Format("Jan 2, 2006")
	}
	summary := lead
	if summary == "" && len(sections) > 0 && len(sections[0].Paras) > 0 {
		summary = sections[0].Paras[0]
	}
	if len(summary) > 240 {
		summary = summary[:237] + "…"
	}
	return appKnowledgePage{
		ID:         id,
		Title:      title,
		Category:   category,
		UpdatedAt:  updated,
		Summary:    summary,
		Infobox:    []appKnowledgeInfoRow{},
		Lead:       lead,
		Sections:   sections,
		References: []appKnowledgeRef{},
		Categories: []string{legacyKnowledgeCategoryTag},
		SeeAlso:    []string{},
	}, true
}

// legacyHTMLCommentRe matches HTML comments, including multi-line ones. The
// previous product embedded machine metadata this way (e.g. the
// "<!-- wuphf:entity-article ... -->" marker on generated entity articles);
// comments are never article content and must not render as body text.
//
// Known limitation, accepted for legacy archaeology: this is a plain regex
// with no code-fence awareness, so a literal "<!-- ... -->" inside a fenced
// code block is stripped too. The legacy generators never wrote such fences,
// and stripping a rare fenced example beats rendering machine metadata on
// every preserved entity page. An unterminated "<!--" is left as-is.
var legacyHTMLCommentRe = regexp.MustCompile(`(?s)<!--.*?-->`)

// parseLegacyMarkdown splits a legacy article into the page shape the reader
// renders: a title from YAML frontmatter or the first "# " heading, the text
// before the first "## " as the lead, and one section per "## " heading. HTML
// comments are machine metadata and are stripped; everything else is preserved
// verbatim as paragraphs — no rewriting, no citations.
func parseLegacyMarkdown(raw string) (title, lead string, sections []appKnowledgeSection) {
	body := strings.ReplaceAll(raw, "\r\n", "\n")

	// YAML frontmatter: keep only a title, drop the rest of the block.
	if strings.HasPrefix(body, "---\n") {
		if end := strings.Index(body[4:], "\n---"); end >= 0 {
			front := body[4 : 4+end]
			for _, line := range strings.Split(front, "\n") {
				if t, ok := strings.CutPrefix(strings.TrimSpace(line), "title:"); ok {
					title = strings.Trim(strings.TrimSpace(t), `"'`)
				}
			}
			rest := body[4+end+4:]
			body = strings.TrimPrefix(rest, "\n")
		}
	}

	body = legacyHTMLCommentRe.ReplaceAllString(body, "")

	current := appKnowledgeSection{}
	flush := func() {
		if current.Heading == "" && len(current.Paras) == 0 {
			return
		}
		if current.Heading == "" {
			lead = strings.Join(current.Paras, "\n\n")
		} else {
			sections = append(sections, current)
		}
		current = appKnowledgeSection{}
	}

	var para []string
	endPara := func() {
		if len(para) == 0 {
			return
		}
		current.Paras = append(current.Paras, strings.Join(para, "\n"))
		para = nil
	}

	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		// The first "# " heading is the title wherever it sits — the real
		// legacy articles put prose (and formerly a metadata comment) before
		// it, and the filename-slug fallback mangles names ("Add diana").
		// With a frontmatter title already set, an H1 stays body text.
		case strings.HasPrefix(trimmed, "# ") && title == "":
			title = strings.TrimSpace(trimmed[2:])
		case strings.HasPrefix(trimmed, "## "):
			endPara()
			flush()
			current.Heading = strings.TrimSpace(trimmed[3:])
		case trimmed == "":
			endPara()
		default:
			para = append(para, line)
		}
	}
	endPara()
	flush()
	return title, lead, sections
}

// humanizeLegacyName turns a kebab/snake filename into a readable title.
func humanizeLegacyName(name string) string {
	words := strings.FieldsFunc(name, func(r rune) bool { return r == '-' || r == '_' })
	if len(words) == 0 {
		return name
	}
	words[0] = strings.ToUpper(words[0][:1]) + words[0][1:]
	return strings.Join(words, " ")
}
