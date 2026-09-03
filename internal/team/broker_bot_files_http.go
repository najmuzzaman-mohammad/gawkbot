package team

// broker_agent_files_http.go owns the HTTP surface the web UI uses to VIEW and
// EDIT a bot's instruction files (SOUL / IDENTITY / OPERATIONS / TOOLS) and
// the office-wide USER.md. Two endpoints:
//
//	GET  /bot-files/read?path=bots/{slug}/SOUL.md
//	POST /bot-files/write   { path, content, commit_message, expected_sha }
//
// Design + security notes
// =======================
//
//   - These are deliberately SEPARATE from the /wiki/* endpoints. They route
//     through the bot-file storage layer (agent_files.go), which validates
//     with the strict validateBotFilePath allowlist — bots/{slug}/{canonical
//     file}.md and office/USER.md only — and never regenerates the team/ article
//     index. Reusing /wiki/write would have widened the 20-caller
//     validateArticlePath gate AND pushed instruction files into the team
//     catalog. A dedicated, tightly-scoped surface is the smaller, safer change.
//   - The write path is HTTP-only (not exposed via any MCP tool) and is gated
//     two ways: humanRouteAllowed keeps the human/web token to this path, AND
//     handleBotFileWrite hard-requires a human-session actor. The second check
//     matters because broker-token actors bypass humanRouteAllowed — without it
//     a compromised bot holding the broker token could rewrite its own (or
//     another bot's) SOUL/IDENTITY, i.e. prompt-inject via self-modification.
//     The committing identity is resolved server-side so attribution cannot be
//     forged.
//   - Optimistic concurrency mirrors /wiki/write-human exactly: the client sends
//     the per-file expected_sha it opened against; a 409 carries the current SHA
//     and bytes so the editor can prompt re-apply without a second round trip.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// botFileReadResponse is the JSON shape returned by GET /bot-files/read.
type botFileReadResponse struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	SHA     string `json:"sha"`
	// Exists is false when no file has been committed to disk yet — Content
	// then carries the deterministic seed so the editor opens with real text,
	// and the first save (with expected_sha == "") creates the file.
	Exists bool `json:"exists"`
}

// handleBotFileRead returns one bot instruction file's content + SHA.
//
//	GET /bot-files/read?path=bots/{slug}/SOUL.md
//
// When the file has not been backfilled to disk yet, the handler returns the
// deterministic seed content (exists:false, sha:"") so the editor never opens
// blank. The path is validated by the strict bot-file allowlist.
func (b *Broker) handleBotFileRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	worker := b.WikiWorker()
	if worker == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "wiki backend is not active"})
		return
	}
	relPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if err := validateBotFilePath(relPath); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	data, err := worker.BotFileRead(relPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if len(data) > 0 {
		sha, err := worker.Repo().BotFileSHA(r.Context(), relPath)
		if err != nil {
			// A committed file with an unresolvable SHA is a real backend fault
			// (corrupt repo / git failure). Surface it rather than returning an
			// empty SHA, which would let the editor open as if the file had no
			// history and silently risk a stale overwrite.
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "resolve sha: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, botFileReadResponse{
			Path:    relPath,
			Content: string(data),
			SHA:     strings.TrimSpace(sha),
			Exists:  true,
		})
		return
	}

	// File absent on disk — seed the editor with the deterministic content so
	// it is never blank. The first save persists it (expected_sha == "").
	writeJSON(w, http.StatusOK, botFileReadResponse{
		Path:    relPath,
		Content: b.botFileSeedContent(relPath),
		SHA:     "",
		Exists:  false,
	})
}

// botFileSeedContent renders the deterministic seed for an absent instruction
// file so the read endpoint can return real text instead of a blank editor.
// Returns "" when the slug is not a current roster member (the editor then
// opens empty, which is the correct fallback for a stale path).
func (b *Broker) botFileSeedContent(relPath string) string {
	clean := strings.TrimSpace(relPath)
	if clean == officeUserFileRel {
		return renderOfficeUserFile()
	}
	parts := strings.Split(clean, "/")
	if len(parts) != 3 || parts[0] != "agents" {
		return ""
	}
	slug := parts[1]
	name := strings.TrimSuffix(parts[2], ".md")
	members := b.OfficeMembers()
	leadSlug, _ := leadSlugAndName(members)
	for _, m := range members {
		if strings.TrimSpace(m.Slug) == slug {
			return renderBotFileContent(m, name, slug == strings.TrimSpace(leadSlug))
		}
	}
	return ""
}

// handleBotFileWrite saves a human edit to one bot instruction file.
//
//	POST /bot-files/write
//	{ "path": "bots/ceo/SOUL.md", "content": "...",
//	  "commit_message": "human: tighten boundaries", "expected_sha": "abc123" }
//
// Responses mirror /wiki/write-human:
//
//	200 { "path", "commit_sha", "bytes_written" }
//	400 { "error" }            malformed JSON / bad path / empty content
//	409 { "error", "current_sha", "current_content" }   concurrent write
//	503 { "error" }            wiki backend not active
//	500 { "error" }            other failure
func (b *Broker) handleBotFileWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Hard-require a human-session actor. humanRouteAllowed already keeps the
	// human/web token to this path, but broker-token actors bypass that check —
	// a bot must never rewrite an instruction file (its own or another's),
	// since those files are loaded into the system prompt. Writes are human-only.
	actor, ok := requestActorFromContext(r.Context())
	if !ok || actor.Kind != requestActorKindHuman {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "human session required"})
		return
	}
	worker := b.WikiWorker()
	if worker == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "wiki backend is not active"})
		return
	}
	// Cap the body: instruction files are small, and an unbounded decode on a
	// fast loopback connection could exhaust memory before the read timeout.
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)
	var body struct {
		Path          string `json:"path"`
		Content       string `json:"content"`
		CommitMessage string `json:"commit_message"`
		ExpectedSHA   string `json:"expected_sha"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// Pre-validate BEFORE the commit so a rejection never touches the tree.
	if err := validateBotFilePath(body.Path); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.Content) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content is required"})
		return
	}

	// actor is a verified human (checked above); resolve its git identity so the
	// commit is attributed server-side and cannot be forged by the client.
	identity := humanIdentityFromActor(actor)

	sha, n, err := worker.Repo().CommitBotFileHuman(
		r.Context(), body.Path, body.Content, body.ExpectedSHA, body.CommitMessage, identity,
	)
	if err != nil {
		if errors.Is(err, ErrWikiSHAMismatch) {
			// Return the current bytes so the editor can show the reload prompt
			// without a second round trip. sha carries the current SHA here.
			current, _ := worker.BotFileRead(body.Path)
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":           err.Error(),
				"current_sha":     sha,
				"current_content": string(current),
			})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":          body.Path,
		"commit_sha":    sha,
		"bytes_written": n,
	})
}

// handleBotFileGenerate authors a richer DRAFT of one prose instruction file
// with the LLM and returns it for human review. It never commits — the editor
// opens with the draft and the human saves (or discards) it.
//
//	POST /bot-files/generate  { path, hint }
//	200 { "path", "content" }
//	400 / 403 / 500 / 503 { "error" }
//
// Human-only (same as write): triggering a model call is a human authoring
// action, not something a bot should drive over HTTP.
func (b *Broker) handleBotFileGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	actor, ok := requestActorFromContext(r.Context())
	if !ok || actor.Kind != requestActorKindHuman {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "human session required"})
		return
	}
	if b.generateBotFileFn == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "bot-file generation is not available"})
		return
	}
	var body struct {
		Path string `json:"path"`
		Hint string `json:"hint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if err := validateBotFilePath(body.Path); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	type genResult struct {
		content string
		err     error
	}
	ch := make(chan genResult, 1)
	go func() {
		c, e := b.generateBotFileFn(ctx, body.Path, body.Hint)
		ch <- genResult{c, e}
	}()
	select {
	case <-ctx.Done():
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "generation timed out"})
		return
	case res := <-ch:
		if res.err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": res.err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": body.Path, "content": res.content})
	}
}
