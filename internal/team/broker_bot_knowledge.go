package team

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// broker_agent_knowledge.go — Knowledge is what a BOT knows.
//
// Knowledge used to hang off an app. It does not belong there: a page is
// something a particular bot learned, so it belongs to that bot. The
// storage for that already existed and is not new here — the wiki git repo has
// carried per-bot draft notes at bots/{slug}/notebook/*.md since the
// notebook subsystem shipped, alongside the shared, reviewed articles under
// team/. This file makes that split the product surface:
//
//	bots/{slug}/notebook/*.md   what ONE bot knows (private to that bot)
//	team/**.md                    the global wiki (shared, trusted, reviewed)
//
// PROMOTION is the only bridge between the two, and it has exactly one gate: a
// human. Two entry points, one mechanism.
//
//  1. A human promotes a page they are reading.
//     POST /bot-knowledge/promote
//  2. A bot judges a page worth sharing and ASKS. The broker raises an
//     approval card; the promotion happens only if a human approves it.
//     POST /bot-knowledge/promotion-request
//
// ── The confused-deputy problem, and how it is closed ────────────────────────
//
// Case 2 is a human approving one thing while the broker could execute another
// (see internal/teammcp/actions.go, which fixed this same class of bug for
// external actions). Four properties are load-bearing here; changing any of
// them reopens the hole:
//
//   - IMMUTABLE SNAPSHOT. The broker reads the note off disk ITSELF at request
//     time and stores those exact bytes on the approval request
//     (knowledgePromotionSpec.Content) together with their sha256. On approval
//     it promotes the SNAPSHOT, never a re-read of the file. A bot that
//     rewrites its note between asking and being approved changes nothing about
//     what lands in the wiki.
//   - BOT TEXT IS NEVER TRUSTED. The bot supplies only a source path and a
//     rationale. The rationale and the note title are pushed through
//     sanitizeKnowledgeCardText before they reach the card, so bot prose
//     cannot forge card structure. The note body travels as a structured field,
//     never spliced into the card's context string, and the UI renders it as
//     plain text.
//   - NO FORGED SPECS. knowledgePromotionSpec is set by this file alone. It is
//     deliberately NOT a field of the POST /requests body, so a bot cannot
//     hand-craft an approval request that promotes arbitrary content.
//   - PER-PAGE, NO BLANKET GRANTS. One approval names one source path and one
//     content hash, and is consumed on use (PromotedPath is stamped). The
//     dedupe key is keyed by the content hash, so a different page can never
//     ride a previous page's approval.
//
// Provenance survives promotion: the promoted article keeps the note verbatim
// and gains a broker-authored "Provenance" section naming the bot, the source
// path, the approver, the date, and the content hash. That footer is written by
// the broker, is not bot-controllable, and is the citation for the page.

const (
	// botKnowledgeMaxPages bounds one bot's page list.
	botKnowledgeMaxPages = 200
	// botKnowledgeMaxNoteBytes bounds a single promotable note. A note larger
	// than this is readable in the bot's Knowledge but cannot be promoted:
	// nobody reviews a megabyte on an approval card, and an approval nobody read
	// is not an approval.
	botKnowledgeMaxNoteBytes = 256 * 1024
	// knowledgePromotionDefaultGroup is the team/ section a promotion lands in
	// when no target is given. "learnings" is the existing home for reviewed
	// things the team figured out.
	knowledgePromotionDefaultGroup = "learnings"
	// knowledgePromotionDedupePrefix keys the approval dedupe on CONTENT, so a
	// retry of the same ask collapses onto the open card while a different page
	// (or an edited one) always raises its own.
	knowledgePromotionDedupePrefix = "knowledge-promote:"
)

// knowledgePromotionSpec is the immutable snapshot of one promotion a bot
// asked a human to approve. It is created only by requestKnowledgePromotion,
// which reads Content off disk itself; nothing a bot sends populates it.
type knowledgePromotionSpec struct {
	// Bot is the slug whose notebook the page came from.
	Bot string `json:"agent"`
	// SourcePath is the repo-relative note (bots/{slug}/notebook/{file}.md).
	SourcePath string `json:"source_path"`
	// TargetPath is the team/ article this promotion would create.
	TargetPath string `json:"target_path"`
	// Title is the note's title, sanitized for display.
	Title string `json:"title"`
	// Content is the EXACT note body the human is shown and that gets promoted.
	Content string `json:"content"`
	// ContentSHA is sha256(Content), hex. Re-verified before the write.
	ContentSHA string `json:"content_sha"`
	// Reason is the bot's sanitized rationale for asking.
	Reason string `json:"reason,omitempty"`
	// RequestedAt is when the snapshot was taken.
	RequestedAt string `json:"requested_at"`
	// PromotedPath / PromotedAt / PromotedBy are stamped once the promotion has
	// landed. A non-empty PromotedPath consumes the approval: it can never
	// promote a second time.
	PromotedPath string `json:"promoted_path,omitempty"`
	PromotedAt   string `json:"promoted_at,omitempty"`
	PromotedBy   string `json:"promoted_by,omitempty"`
}

// knowledgePromotionStatus is the per-page promotion standing the reader shows:
// private to the bot, waiting on a human, or already in the shared wiki.
type knowledgePromotionStatus struct {
	// State is "private", "pending", or "promoted".
	State string `json:"state"`
	// WikiPath is the team/ article this page was promoted to ("promoted" only).
	// This is the successor of the previous product's PromotedWikiPath sidecar
	// field (broker_apps_knowledge_legacy.go) — same concept, live surface.
	WikiPath string `json:"wikiPath,omitempty"`
	// RequestID is the open approval card ("pending" only).
	RequestID string `json:"requestId,omitempty"`
	// ContentSHA is sha256 of the note as read. The promote call must echo it,
	// so a human can only ever promote the bytes they were shown.
	ContentSHA string `json:"contentSha"`
}

const (
	knowledgePromotionStatePrivate  = "private"
	knowledgePromotionStatePending  = "pending"
	knowledgePromotionStatePromoted = "promoted"
)

// ── Reading one bot's knowledge ────────────────────────────────────────────

// knowledgeWikiRoot resolves the wiki repo root. It prefers the live worker's
// root and falls back to the configured path, so a bot's knowledge is
// readable even before (or without) the markdown worker being up — the notes are
// plain files, and reading them needs no git.
func (b *Broker) knowledgeWikiRoot() string {
	if worker := b.WikiWorker(); worker != nil && worker.Repo() != nil {
		return worker.Repo().Root()
	}
	return WikiRootDir()
}

// botNotebookRel builds the repo-relative path of one notebook note.
func botNotebookRel(bot, file string) string {
	return "agents/" + bot + "/notebook/" + file
}

// loadBotNotebookPages reads one bot's notebook notes into knowledge pages,
// newest-titled-first by title. Each page carries its Bot and SourcePath so
// the reader can cite where the knowledge came from and the promote path can
// address it. A missing notebook yields nil — a bot that has not written
// anything down knows nothing, and says so.
//
// Extracted from loadLegacyKnowledgePages (which walks every bot) so the
// per-bot surface and the preservation pass share one parser; the "Notebook ·
// <bot>" category and id scheme are unchanged.
func loadBotNotebookPages(root, bot string) []appKnowledgePage {
	if validateNotebookSlug(bot) != nil {
		return nil
	}
	notes, err := os.ReadDir(filepath.Join(root, "agents", bot, "notebook"))
	if err != nil {
		return nil
	}
	var pages []appKnowledgePage
	for _, note := range notes {
		if note.IsDir() {
			continue
		}
		path := filepath.Join(root, "agents", bot, "notebook", note.Name())
		id := "notebook-" + slugifyKnowledgeID(bot+"-"+note.Name())
		page, ok := legacyPageFromFile(path, id, "Notebook · "+bot)
		if !ok {
			continue
		}
		page.Bot = bot
		page.SourcePath = botNotebookRel(bot, note.Name())
		pages = append(pages, page)
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Title < pages[j].Title })
	if len(pages) > botKnowledgeMaxPages {
		fmt.Fprintf(os.Stderr, "broker: bot %s knowledge capped at %d of %d pages\n",
			bot, botKnowledgeMaxPages, len(pages))
		pages = pages[:botKnowledgeMaxPages]
	}
	return pages
}

// botKnowledgePages loads one bot's pages and stamps each with its live
// promotion standing: already in the wiki, waiting on a human, or private.
func (b *Broker) botKnowledgePages(bot string) []appKnowledgePage {
	root := b.knowledgeWikiRoot()
	pages := loadBotNotebookPages(root, bot)
	pending := b.pendingPromotionsBySource(bot)
	for i := range pages {
		raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(pages[i].SourcePath)))
		if err != nil {
			continue
		}
		status := knowledgePromotionStatus{
			State:      knowledgePromotionStatePrivate,
			ContentSHA: knowledgeContentSHA(string(raw)),
		}
		if req, ok := pending[pages[i].SourcePath]; ok {
			status.State = knowledgePromotionStatePending
			status.RequestID = req
		}
		if target, ok := promotedWikiPathFor(root, pages[i]); ok {
			status.State = knowledgePromotionStatePromoted
			status.WikiPath = target
		}
		pages[i].Promotion = &status
	}
	return pages
}

// pendingPromotionsBySource maps source path → open approval request id for one
// bot, so the reader can show "waiting on you" instead of offering a second
// promote button for a page already on the human's desk.
func (b *Broker) pendingPromotionsBySource(bot string) map[string]string {
	out := map[string]string{}
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := range b.requests {
		spec := b.requests[i].KnowledgePromotion
		if spec == nil || spec.Bot != bot || spec.PromotedPath != "" {
			continue
		}
		if !requestIsActive(b.requests[i]) {
			continue
		}
		out[spec.SourcePath] = b.requests[i].ID
	}
	return out
}

// promotedWikiPathFor reports the team/ article a page was promoted to, by
// looking for the broker-written provenance marker naming this source path.
// The marker is the only evidence we trust: it is written by promoteKnowledge
// and names the exact note, so a coincidentally similar article never reads as
// a promotion.
func promotedWikiPathFor(root string, page appKnowledgePage) (string, bool) {
	marker := knowledgeProvenanceMarker(page.SourcePath)
	teamRoot := filepath.Join(root, "team")
	found := ""
	_ = filepath.Walk(teamRoot, func(path string, info os.FileInfo, werr error) error {
		if werr != nil || found != "" {
			return werr
		}
		if info.IsDir() {
			if strings.HasPrefix(info.Name(), ".") && path != teamRoot {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(info.Name()), ".md") {
			return nil
		}
		// Unreadable notes are skipped, not fatal: the walk keeps searching.
		if raw, err := os.ReadFile(path); err == nil && strings.Contains(string(raw), marker) {
			rel := strings.TrimPrefix(path, root+string(filepath.Separator))
			found = filepath.ToSlash(rel)
		}
		return nil
	})
	return found, found != ""
}

// ── Sanitizing bot-authored text for the approval card ─────────────────────

// sanitizeKnowledgeCardText collapses control characters and structural
// delimiters in bot-authored text into safe inline text. It is the package
// team twin of teammcp.sanitizeContextValue (internal/teammcp/actions.go), which
// exists because the approval card is parsed line-first: a newline plus a
// forged label at line start lets bot prose pose as a broker-authored section,
// which is how a human ends up approving one thing while another is executed.
// Same alphabet, same reasoning; kept here because teammcp's copy is unexported
// and importing it from this package would invert the dependency.
//
// Output is one visible line, so a forged block reads as one long rambling
// sentence rather than an authoritative-looking section.
func sanitizeKnowledgeCardText(s string) string {
	if s == "" {
		return s
	}
	r := strings.NewReplacer(
		"\r\n", " ",
		"\n", " ",
		"\r", " ",
		" ", " ",
		" ", " ",
		" ", " ",
		"•", "·", // U+2022 BULLET → U+00B7 MIDDLE DOT
	)
	cleaned := r.Replace(s)
	// Strip any remaining C0/C1 control characters (a lone \v, \f, or an ANSI
	// escape introducer) before collapsing whitespace.
	cleaned = strings.Map(func(c rune) rune {
		if c < 0x20 || (c >= 0x7f && c <= 0x9f) {
			return ' '
		}
		return c
	}, cleaned)
	return strings.Join(strings.Fields(cleaned), " ")
}

// knowledgeContentSHA is the content identity used everywhere in this file: the
// human approves a hash, and the broker writes the bytes that hash.
func knowledgeContentSHA(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// ── Paths ────────────────────────────────────────────────────────────────────

var errKnowledgeBadPath = errors.New("knowledge: invalid path")

// resolveBotNotePath validates that relPath is exactly one of `bot`'s own
// notebook notes and returns its absolute path. It refuses traversal, absolute
// paths, non-canonical spellings, another bot's notebook, and anything outside
// the notebook subtree — so a promotion can only ever address the asking bot's
// own knowledge.
func resolveBotNotePath(root, bot, relPath string) (string, error) {
	if err := validateNotebookSlug(bot); err != nil {
		return "", fmt.Errorf("%w: %w", errKnowledgeBadPath, err)
	}
	relPath = strings.TrimSpace(relPath)
	if relPath == "" {
		return "", fmt.Errorf("%w: source path is required", errKnowledgeBadPath)
	}
	if filepath.IsAbs(relPath) || strings.Contains(relPath, "..") || hasControlByte(relPath) {
		return "", fmt.Errorf("%w: %q", errKnowledgeBadPath, relPath)
	}
	clean := filepath.ToSlash(filepath.Clean(relPath))
	if clean != filepath.ToSlash(relPath) {
		return "", fmt.Errorf("%w: path must be canonical; got %q", errKnowledgeBadPath, relPath)
	}
	prefix := "agents/" + bot + "/notebook/"
	if !strings.HasPrefix(clean, prefix) {
		return "", fmt.Errorf("%w: must be under %s; got %q", errKnowledgeBadPath, prefix, relPath)
	}
	name := strings.TrimPrefix(clean, prefix)
	if name == "" || strings.Contains(name, "/") || !strings.EqualFold(filepath.Ext(name), ".md") {
		return "", fmt.Errorf("%w: must name one .md note directly under %s; got %q", errKnowledgeBadPath, prefix, relPath)
	}
	abs := filepath.Join(root, filepath.FromSlash(clean))
	if !isPathWithin(root, abs) {
		return "", fmt.Errorf("%w: resolves outside the wiki root", errKnowledgeBadPath)
	}
	return abs, nil
}

// knowledgeTargetSegmentOK allows only quiet path segments: lowercase-ish
// filenames with no separators, no dots, no spaces.
func knowledgeTargetSegmentOK(seg string) bool {
	if seg == "" || len(seg) > 80 {
		return false
	}
	for _, r := range seg {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

// validatePromotionTarget checks the destination article path before the human
// ever sees it, so the card cannot advertise one destination and the write land
// somewhere else. Repo.CreatePage re-validates independently.
func validatePromotionTarget(target string) (string, error) {
	target = filepath.ToSlash(strings.TrimSpace(target))
	if target == "" || hasControlByte(target) || strings.Contains(target, "..") {
		return "", fmt.Errorf("%w: target %q", errKnowledgeBadPath, target)
	}
	if !strings.HasPrefix(target, "team/") || !strings.HasSuffix(strings.ToLower(target), ".md") {
		return "", fmt.Errorf("%w: target must be a team/<section>/<slug>.md article; got %q", errKnowledgeBadPath, target)
	}
	segs := strings.Split(target, "/")
	if len(segs) < 3 || len(segs) > 5 {
		return "", fmt.Errorf("%w: target must be team/<section>/<slug>.md; got %q", errKnowledgeBadPath, target)
	}
	for _, seg := range segs[1 : len(segs)-1] {
		if !knowledgeTargetSegmentOK(seg) {
			return "", fmt.Errorf("%w: bad section %q in %q", errKnowledgeBadPath, seg, target)
		}
	}
	last := strings.TrimSuffix(segs[len(segs)-1], filepath.Ext(segs[len(segs)-1]))
	if !knowledgeTargetSegmentOK(last) {
		return "", fmt.Errorf("%w: bad article name in %q", errKnowledgeBadPath, target)
	}
	return target, nil
}

// defaultPromotionTarget places a promoted note in the team/learnings section
// under a slug derived from its title.
func defaultPromotionTarget(title, sourcePath string) string {
	slug := slugifyKnowledgeID(title)
	if slug == "page" || slug == "" {
		base := filepath.Base(sourcePath)
		slug = slugifyKnowledgeID(strings.TrimSuffix(base, filepath.Ext(base)))
	}
	return "team/" + knowledgePromotionDefaultGroup + "/" + slug + ".md"
}

// ── Snapshot + promote ───────────────────────────────────────────────────────

// knowledgeProvenanceMarker is the stable, broker-written line that records
// which note an article was promoted from. It is also how the reader recognizes
// an already-promoted page.
func knowledgeProvenanceMarker(sourcePath string) string {
	return "wuphf:promoted-from " + sourcePath
}

// renderPromotedArticle returns the article body written to the wiki: the
// approved note VERBATIM, followed by a broker-authored Provenance section.
//
// The footer is deliberately outside the approved bytes and outside bot
// control. It is what keeps the honesty rule true after promotion — the page
// still says which bot knew it, where it came from, who approved it, and
// when — and the human is told on the card that it will be appended.
func renderPromotedArticle(spec knowledgePromotionSpec, approvedBy, promotedAt string) string {
	var b strings.Builder
	b.WriteString(spec.Content)
	if !strings.HasSuffix(spec.Content, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("\n## Provenance\n\n")
	fmt.Fprintf(&b, "Promoted from @%s's knowledge (`%s`) on %s.\n",
		spec.Bot, spec.SourcePath, promotedAt)
	fmt.Fprintf(&b, "Approved by %s. Source content sha256: `%s`.\n",
		approvedBy, spec.ContentSHA)
	fmt.Fprintf(&b, "\n<!-- %s -->\n", knowledgeProvenanceMarker(spec.SourcePath))
	return b.String()
}

// snapshotKnowledgePromotion reads the note off disk and builds the immutable
// spec. This is the ONLY producer of a knowledgePromotionSpec, and it never
// takes content from a caller.
func (b *Broker) snapshotKnowledgePromotion(bot, sourcePath, targetPath, reason string) (knowledgePromotionSpec, error) {
	root := b.knowledgeWikiRoot()
	abs, err := resolveBotNotePath(root, bot, sourcePath)
	if err != nil {
		return knowledgePromotionSpec{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return knowledgePromotionSpec{}, fmt.Errorf("knowledge: no such note %q", sourcePath)
	}
	if info.IsDir() || info.Size() > botKnowledgeMaxNoteBytes {
		return knowledgePromotionSpec{}, fmt.Errorf("knowledge: %q is not a promotable note (max %d bytes)", sourcePath, botKnowledgeMaxNoteBytes)
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return knowledgePromotionSpec{}, fmt.Errorf("knowledge: read %q: %w", sourcePath, err)
	}
	content := string(raw)
	if strings.TrimSpace(content) == "" {
		return knowledgePromotionSpec{}, fmt.Errorf("knowledge: %q is empty; there is nothing to promote", sourcePath)
	}
	title, _, _ := parseLegacyMarkdown(content)
	if strings.TrimSpace(title) == "" {
		base := filepath.Base(sourcePath)
		title = humanizeLegacyName(strings.TrimSuffix(base, filepath.Ext(base)))
	}
	title = sanitizeKnowledgeCardText(title)
	clean := filepath.ToSlash(filepath.Clean(sourcePath))

	target := strings.TrimSpace(targetPath)
	if target == "" {
		target = defaultPromotionTarget(title, clean)
	}
	target, err = validatePromotionTarget(target)
	if err != nil {
		return knowledgePromotionSpec{}, err
	}
	return knowledgePromotionSpec{
		Bot:         bot,
		SourcePath:  clean,
		TargetPath:  target,
		Title:       clampRunes(title, 120),
		Content:     content,
		ContentSHA:  knowledgeContentSHA(content),
		Reason:      clampRunes(sanitizeKnowledgeCardText(reason), 400),
		RequestedAt: time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// promoteKnowledge writes an approved snapshot into the global wiki as a git
// commit. It re-verifies sha256(spec.Content) against spec.ContentSHA first: the
// bytes that land are the bytes that were hashed, which are the bytes the human
// was shown. Returns the commit SHA.
func (b *Broker) promoteKnowledge(ctx context.Context, spec knowledgePromotionSpec, approvedBy string) (string, error) {
	worker := b.WikiWorker()
	if worker == nil || worker.Repo() == nil {
		return "", fmt.Errorf("knowledge: the wiki backend is not active, so nothing can be promoted right now")
	}
	if knowledgeContentSHA(spec.Content) != spec.ContentSHA {
		// Belt and braces on top of the immutable snapshot: if in-memory state
		// were ever tampered with, the write refuses rather than promoting
		// content nobody approved.
		return "", fmt.Errorf("knowledge: approved content no longer matches its hash; refusing to promote")
	}
	target, err := validatePromotionTarget(spec.TargetPath)
	if err != nil {
		return "", err
	}
	promotedAt := time.Now().UTC().Format("2006-01-02")
	body := renderPromotedArticle(spec, approvedBy, promotedAt)
	sha, err := worker.Repo().CreatePage(ctx, target, "", body, brokerHumanIdentityRegistry().Local())
	if err != nil {
		return "", err
	}
	b.PublishWikiEvent(wikiWriteEvent{
		Path:       target,
		CommitSHA:  sha,
		AuthorSlug: spec.Bot,
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
	})
	return sha, nil
}

// ── The bot's ask ──────────────────────────────────────────────────────────

// requestKnowledgePromotion raises ONE approval card asking a human to promote
// one page. The bot never promotes; it asks, and the answer decides.
//
// Returns the request id. An identical open ask (same content hash) returns the
// existing card rather than stacking a second one.
func (b *Broker) requestKnowledgePromotion(bot, sourcePath, targetPath, reason string) (string, error) {
	if worker := b.WikiWorker(); worker == nil || worker.Repo() == nil {
		// Refuse up front. Raising a card the broker could not honor would put a
		// decision in front of the human that does nothing when they make it.
		return "", fmt.Errorf("knowledge: the wiki backend is not active, so nothing can be promoted right now")
	}
	spec, err := b.snapshotKnowledgePromotion(bot, sourcePath, targetPath, reason)
	if err != nil {
		return "", err
	}
	dedupeKey := knowledgePromotionDedupePrefix + spec.ContentSHA

	question := fmt.Sprintf("@%s wants to promote %q into the team wiki. Approve?", bot, spec.Title)
	var ctxb strings.Builder
	if spec.Reason != "" {
		ctxb.WriteString("Why: ")
		ctxb.WriteString(spec.Reason)
		ctxb.WriteString("\n\n")
	}
	ctxb.WriteString("From: " + spec.SourcePath + "\n")
	ctxb.WriteString("Creates: " + spec.TargetPath + "\n")
	ctxb.WriteString("Content sha256: " + spec.ContentSHA[:16] + "\n\n")
	ctxb.WriteString("Approving promotes exactly the text shown on this card, plus a provenance footer naming " +
		bot + " as its author. Editing the note after this card is raised does not change what lands.")

	options, recommended := requestOptionDefaults("approval")
	now := time.Now().UTC().Format(time.RFC3339)

	b.mu.Lock()
	defer b.mu.Unlock()
	for i := range b.requests {
		if requestIsActive(b.requests[i]) && strings.TrimSpace(b.requests[i].DedupeKey) == dedupeKey {
			return b.requests[i].ID, nil
		}
	}
	channel, err := b.homeChannelForLocked(bot)
	if err != nil {
		return "", fmt.Errorf("knowledge: no channel to ask in: %w", err)
	}
	b.counter++
	req := humanInterview{
		ID:            fmt.Sprintf("request-%d", b.counter),
		Kind:          "approval",
		Status:        "pending",
		From:          bot,
		Channel:       channel,
		Title:         "Promote to the team wiki: " + spec.Title,
		Question:      question,
		Context:       ctxb.String(),
		Options:       options,
		RecommendedID: recommended,
		DedupeKey:     dedupeKey,
		// Deliberately NOT blocking: one unreviewed page must never park the
		// office. The bot keeps working; the page waits.
		KnowledgePromotion: &spec,
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	b.scheduleRequestLifecycleLocked(&req)
	b.postRequestRaisedChatMessageLocked(&req)
	b.requests = append(b.requests, req)
	b.appendActionLocked("request_created", "office", channel, bot,
		truncateSummary(req.Title, 140), req.ID)
	if err := b.saveLocked(); err != nil {
		return req.ID, fmt.Errorf("knowledge: persist promotion request: %w", err)
	}
	return req.ID, nil
}

// maybePromoteKnowledgeFromApproval runs after a request is answered. When the
// answered request carries a promotion snapshot AND the human approved, the
// SNAPSHOT is promoted — never a re-read of the note. Called from
// handlePostRequestAnswer outside b.mu, mirroring the App Builder proposal hook.
func (b *Broker) maybePromoteKnowledgeFromApproval(requestID, actor string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	b.mu.Lock()
	var (
		spec  knowledgePromotionSpec
		found bool
		idx   int
	)
	for i := range b.requests {
		if b.requests[i].ID != requestID {
			continue
		}
		if b.requests[i].KnowledgePromotion == nil || b.requests[i].Answered == nil {
			b.mu.Unlock()
			return
		}
		// Copy by value: the promotion runs off an immutable local, never off
		// the live pointer another goroutine could reach.
		spec = *b.requests[i].KnowledgePromotion
		idx = i
		found = true
		break
	}
	if !found {
		b.mu.Unlock()
		return
	}
	answer := *b.requests[idx].Answered
	if spec.PromotedPath != "" {
		// Already consumed. One approval promotes exactly once.
		b.mu.Unlock()
		return
	}
	channel := normalizeChannelSlug(b.requests[idx].Channel)
	b.mu.Unlock()

	if !knowledgePromotionApproved(answer.ChoiceID) {
		return
	}

	approver := strings.TrimSpace(actor)
	if approver == "" {
		approver = "a human"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sha, err := b.promoteKnowledge(ctx, spec, approver)

	b.mu.Lock()
	defer b.mu.Unlock()
	b.counter++
	msg := channelMessage{
		ID:        fmt.Sprintf("msg-%d", b.counter),
		From:      "system",
		Channel:   channel,
		Tagged:    uniqueSlugs([]string{spec.Bot}),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	if err != nil {
		msg.Content = fmt.Sprintf("Could not promote %q to the team wiki: %s", spec.Title, strings.TrimSpace(err.Error()))
		b.appendMessageLocked(msg)
		_ = b.saveLocked()
		return
	}
	// Stamp the approval as consumed on the stored request.
	for i := range b.requests {
		if b.requests[i].ID == requestID && b.requests[i].KnowledgePromotion != nil {
			b.requests[i].KnowledgePromotion.PromotedPath = spec.TargetPath
			b.requests[i].KnowledgePromotion.PromotedAt = time.Now().UTC().Format(time.RFC3339)
			b.requests[i].KnowledgePromotion.PromotedBy = approver
			break
		}
	}
	msg.Content = fmt.Sprintf("Promoted %q from @%s's knowledge into the team wiki at %s (%s).",
		spec.Title, spec.Bot, spec.TargetPath, sha)
	b.appendMessageLocked(msg)
	_ = b.saveLocked()
}

// knowledgePromotionApproved reports whether an answer's choice means "yes".
// Anything else — reject, a note without an approve choice, a dismissal — leaves
// the page exactly where it was.
func knowledgePromotionApproved(choiceID string) bool {
	switch strings.ToLower(strings.TrimSpace(choiceID)) {
	case "approve", "approve_with_note":
		return true
	default:
		return false
	}
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

// handleBotKnowledge serves GET /bot-knowledge?bot=<slug> — the pages one
// bot knows, each with its promotion standing. A bot with no notes returns
// an empty list; the reader shows that honestly rather than inventing pages.
func (b *Broker) handleBotKnowledge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	bot := strings.TrimSpace(r.URL.Query().Get("agent"))
	if err := validateNotebookSlug(bot); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid bot slug is required"})
		return
	}
	pages := b.botKnowledgePages(bot)
	if pages == nil {
		pages = []appKnowledgePage{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"agent":         bot,
		"pages":         pages,
		"wiki_writable": b.WikiWorker() != nil,
	})
}

// handleBotKnowledgePromote serves POST /bot-knowledge/promote — a HUMAN
// promoting a page they are reading.
//
// content_sha is REQUIRED and must match the note on disk. The reader sends back
// the hash it displayed, so a human can only promote the bytes they actually
// read; if the bot rewrote the note in between, this answers 409 and the human
// re-reads rather than silently publishing something else.
func (b *Broker) handleBotKnowledgePromote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	actor, ok := requestActorFromContext(r.Context())
	if !ok || actor.Kind != requestActorKindHuman {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only a human can promote a page into the team wiki"})
		return
	}
	var body struct {
		Bot        string `json:"agent"`
		SourcePath string `json:"source_path"`
		TargetPath string `json:"target_path"`
		ContentSHA string `json:"content_sha"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.ContentSHA) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content_sha is required: promote the page you actually read"})
		return
	}
	spec, err := b.snapshotKnowledgePromotion(strings.TrimSpace(body.Bot), body.SourcePath, body.TargetPath, "")
	if err != nil {
		writeKnowledgePromotionError(w, err)
		return
	}
	if !strings.EqualFold(spec.ContentSHA, strings.TrimSpace(body.ContentSHA)) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error":       "this page changed since you opened it; re-read it before promoting",
			"content_sha": spec.ContentSHA,
		})
		return
	}
	approver := humanMessageSender(actor.Slug)
	sha, err := b.promoteKnowledge(r.Context(), spec, approver)
	if err != nil {
		writeKnowledgePromotionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":       spec.TargetPath,
		"commit_sha": sha,
	})
}

// handleBotKnowledgePromotionRequest serves POST
// /bot-knowledge/promotion-request — a BOT judging a page worth sharing and
// asking a human. It never writes to the wiki; it raises a card.
func (b *Broker) handleBotKnowledgePromotionRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Bot        string `json:"agent"`
		SourcePath string `json:"source_path"`
		TargetPath string `json:"target_path"`
		Reason     string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	bot := strings.TrimSpace(body.Bot)
	if err := validateNotebookSlug(bot); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid bot slug is required"})
		return
	}
	id, err := b.requestKnowledgePromotion(bot, body.SourcePath, body.TargetPath, body.Reason)
	if err != nil {
		writeKnowledgePromotionError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"request_id": id,
		"status":     knowledgePromotionStatePending,
	})
}

// writeKnowledgePromotionError maps promotion failures onto honest status codes:
// a caller mistake is a 4xx the caller can fix, an already-promoted page is a
// 409, and a missing wiki backend is a 503 rather than a generic failure.
func writeKnowledgePromotionError(w http.ResponseWriter, err error) {
	msg := strings.TrimSpace(err.Error())
	switch {
	case errors.Is(err, errKnowledgeBadPath), errors.Is(err, errWikiFSBadPath):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
	case errors.Is(err, errWikiPageExists):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "that wiki article already exists; pick another target path"})
	case strings.Contains(msg, "wiki backend is not active"):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": msg})
	case strings.Contains(msg, "no such note"), strings.Contains(msg, "is empty"):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": msg})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
	}
}
