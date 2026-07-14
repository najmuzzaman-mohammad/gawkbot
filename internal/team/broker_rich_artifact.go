package team

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

const richArtifactRequestMetadataAllowance = 16 * 1024

// handleVisualArtifacts owns the collection route:
//
//	GET  /visual-artifacts?slug=&source_path=
//	POST /visual-artifacts
func (b *Broker) handleVisualArtifacts(w http.ResponseWriter, r *http.Request) {
	worker := b.requireWikiWorker(w, "visual artifact")
	if worker == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		// owner_slug is the frontend-facing query name; slug is the legacy
		// agent-facing name. Accept both so MCP + UI callers can share the
		// same endpoint without translation.
		createdBy := strings.TrimSpace(r.URL.Query().Get("slug"))
		if createdBy == "" {
			createdBy = strings.TrimSpace(r.URL.Query().Get("owner_slug"))
		}
		// source_path is the FE-facing query name; source_markdown_path is
		// the JSON-payload-shaped alias spec'd for the listing contract.
		// Accept both so MCP + UI callers (and any future SDK) can use the
		// shape they already speak.
		sourcePath := strings.TrimSpace(r.URL.Query().Get("source_path"))
		if sourcePath == "" {
			sourcePath = strings.TrimSpace(r.URL.Query().Get("source_markdown_path"))
		}
		filter := RichArtifactFilter{
			CreatedBy:          createdBy,
			SourceMarkdownPath: sourcePath,
		}
		if filter.CreatedBy != "" {
			if err := validateNotebookSlug(filter.CreatedBy); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		}
		if filter.SourceMarkdownPath != "" {
			if err := validateNotebookPath(filter.SourceMarkdownPath); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		}
		artifacts, err := worker.ListRichArtifacts(filter)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"artifacts": artifacts})
	case http.MethodPost:
		var body RichArtifactCreateRequest
		if status, err := decodeRichArtifactCreateRequest(w, r, &body); err != nil {
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		if body.LegacyHTML != nil && os.Getenv("WUPHF_ALLOW_LEGACY_HTML_ARTIFACT_WRITES") != "1" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "html artifact writes are disabled; submit openui_lang"})
			return
		}
		if body.LegacyHTML == nil && os.Getenv("WUPHF_DISABLE_OPENUI_ARTIFACT_CREATION") == "1" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "OpenUI artifact creation is temporarily disabled"})
			return
		}
		slug, status, err := richArtifactAuthenticatedSlug(r, body.Slug, "slug")
		if err != nil {
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		body.Slug = slug
		artifact, content, err := newRichArtifact(body, time.Now())
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		stored, sha, n, err := worker.CreateRichArtifact(r.Context(), artifact, content, body.CommitMessage)
		if err != nil {
			writeRichArtifactError(w, err)
			return
		}
		// stored carries the canonical notebook-home attachment chosen by the
		// worker. Always pass it through DerivePromotion so the response shape
		// matches the list/get endpoints (non-nil promotion field).
		writeJSON(w, http.StatusOK, map[string]any{
			"artifact":      stored.WithDerivedPromotion(),
			"commit_sha":    sha,
			"bytes_written": n,
		})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleVisualArtifactSubpath owns:
//
//	GET  /visual-artifacts/{id}
//	POST /visual-artifacts/{id}/promote
func (b *Broker) handleVisualArtifactSubpath(w http.ResponseWriter, r *http.Request) {
	worker := b.requireWikiWorker(w, "visual artifact")
	if worker == nil {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/visual-artifacts/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "visual artifact not found"})
		return
	}
	id := parts[0]
	if err := validateRichArtifactID(id); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		artifact, content, err := worker.RichArtifact(id)
		if err != nil {
			writeRichArtifactReadError(w, err)
			return
		}
		writeRichArtifactDetail(w, r, artifact, content)
		return
	}
	if len(parts) == 2 && parts[1] == "promote" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body RichArtifactPromoteRequest
		if status, err := decodeRichArtifactJSONRequest(w, r, &body, richArtifactMaxPromotionBytes); err != nil {
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		actorSlug, status, err := richArtifactAuthenticatedSlug(r, body.ActorSlug, "actor_slug")
		if err != nil {
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		if actorSlug == "" {
			actorSlug = "human"
		}
		if actor, ok := requestActorFromContext(r.Context()); !ok || actor.Kind != requestActorKindHuman {
			artifact, _, readErr := worker.RichArtifact(id)
			if readErr != nil {
				writeRichArtifactReadError(w, readErr)
				return
			}
			if artifact.CreatedBy != actorSlug {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the artifact owner or a human reviewer may promote it"})
				return
			}
		}
		artifact, sha, n, err := worker.PromoteRichArtifact(
			r.Context(),
			actorSlug,
			id,
			strings.TrimSpace(body.TargetWikiPath),
			body.MarkdownSummary,
			strings.TrimSpace(body.Mode),
			body.CommitMessage,
		)
		if err != nil {
			writeRichArtifactError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"artifact":      artifact,
			"commit_sha":    sha,
			"bytes_written": n,
		})
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "visual artifact not found"})
}

func richArtifactAuthenticatedSlug(r *http.Request, bodySlug, fieldName string) (string, int, error) {
	bodySlug = strings.TrimSpace(bodySlug)
	agentSlug := strings.TrimSpace(r.Header.Get(agentRateLimitHeader))
	if agentSlug != "" {
		if err := validateNotebookSlug(agentSlug); err != nil {
			return "", http.StatusBadRequest, err
		}
		if bodySlug != "" && bodySlug != agentSlug {
			return "", http.StatusForbidden, errors.New(fieldName + " does not match authenticated agent")
		}
		if actor, ok := requestActorFromContext(r.Context()); ok && actor.Kind == requestActorKindHuman {
			humanSlug := humanIdentityFromActor(actor).Slug
			if humanSlug != "" && humanSlug != agentSlug {
				return "", http.StatusForbidden, errors.New("session identity does not match authenticated agent")
			}
		}
		return agentSlug, 0, nil
	}
	if actor, ok := requestActorFromContext(r.Context()); ok && actor.Kind == requestActorKindHuman {
		return humanIdentityFromActor(actor).Slug, 0, nil
	}
	return bodySlug, 0, nil
}

// handleWikiVisualArtifact returns the promoted visual artifact associated with
// a wiki article, when one exists.
//
//	GET /wiki/visual?path=team/decisions/foo.md
func (b *Broker) handleWikiVisualArtifact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	worker := b.requireWikiWorker(w, "visual artifact")
	if worker == nil {
		return
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if err := validateArticlePath(path); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	artifacts, err := worker.ListRichArtifacts(RichArtifactFilter{PromotedWikiPath: path})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if len(artifacts) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "visual artifact not found"})
		return
	}
	artifact, content, err := worker.RichArtifact(artifacts[0].ID)
	if err != nil {
		writeRichArtifactReadError(w, err)
		return
	}
	writeRichArtifactDetail(w, r, artifact, content)
}

func decodeRichArtifactCreateRequest(w http.ResponseWriter, r *http.Request, dst *RichArtifactCreateRequest) (int, error) {
	limit := int64(richArtifactMaxOpenUIBytes + richArtifactRequestMetadataAllowance)
	if os.Getenv("WUPHF_ALLOW_LEGACY_HTML_ARTIFACT_WRITES") == "1" {
		limit = int64(richArtifactMaxHTMLBytes + richArtifactRequestMetadataAllowance)
	}
	return decodeRichArtifactJSONRequest(w, r, dst, limit)
}

func decodeRichArtifactJSONRequest(w http.ResponseWriter, r *http.Request, dst any, limit int64) (int, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return http.StatusRequestEntityTooLarge, fmt.Errorf("visual artifact request exceeds %d bytes", limit)
		}
		return http.StatusBadRequest, fmt.Errorf("read visual artifact request: %w", err)
	}
	if !utf8.Valid(raw) {
		return http.StatusBadRequest, errors.New("visual artifact request must be valid UTF-8")
	}
	if err := rejectDuplicateTopLevelJSONFields(raw); err != nil {
		return http.StatusBadRequest, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return http.StatusBadRequest, fmt.Errorf("invalid visual artifact json: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return http.StatusBadRequest, err
	}
	return 0, nil
}

func rejectDuplicateTopLevelJSONFields(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("invalid visual artifact json: %w", err)
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return errors.New("visual artifact request must be one JSON object")
	}
	if err := rejectDuplicateJSONObjectFields(decoder); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func rejectDuplicateJSONObjectFields(decoder *json.Decoder) error {
	seen := map[string]struct{}{}
	for decoder.More() {
		fieldToken, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("invalid visual artifact json: %w", err)
		}
		field, ok := fieldToken.(string)
		if !ok {
			return errors.New("visual artifact request contains a non-string field name")
		}
		canonicalField := strings.ToLower(field)
		if _, exists := seen[canonicalField]; exists {
			return fmt.Errorf("visual artifact request contains duplicate field %q", field)
		}
		seen[canonicalField] = struct{}{}
		if err := consumeStrictJSONValue(decoder); err != nil {
			return fmt.Errorf("invalid visual artifact field %q: %w", field, err)
		}
	}
	closing, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("invalid visual artifact json: %w", err)
	}
	if closing != json.Delim('}') {
		return errors.New("invalid visual artifact object terminator")
	}
	return nil
}

func consumeStrictJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		return rejectDuplicateJSONObjectFields(decoder)
	case '[':
		for decoder.More() {
			if err := consumeStrictJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim(']') {
			return errors.New("invalid visual artifact array terminator")
		}
		return nil
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delim)
	}
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("visual artifact request must contain exactly one JSON value")
		}
		return fmt.Errorf("invalid trailing visual artifact json: %w", err)
	}
	return nil
}

func writeRichArtifactDetail(w http.ResponseWriter, r *http.Request, artifact RichArtifact, content string) {
	if artifact.Representation == richArtifactRepresentationOpenUI {
		if r.URL.Query().Get("accept_representation") == richArtifactRepresentationOpenUI {
			writeJSON(w, http.StatusOK, map[string]any{"artifact": artifact, "openui": content})
			return
		}
		writeJSON(w, http.StatusUpgradeRequired, map[string]string{
			"error": "this artifact requires an OpenUI-capable WUPHF client",
			"code":  "openui_client_upgrade_required",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"artifact": artifact, "html": content})
}

func writeRichArtifactReadError(w http.ResponseWriter, err error) {
	if errors.Is(err, errRichArtifactNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "visual artifact not found", "code": "artifact_not_found"})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error(), "code": "artifact_corrupt"})
}

func writeRichArtifactError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrQueueSaturated):
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrWorkerStopped):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
	case isRichArtifactCallerError(err):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

func isRichArtifactCallerError(err error) bool {
	return errors.Is(err, errRichArtifactCaller)
}
