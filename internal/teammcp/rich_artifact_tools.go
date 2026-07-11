package teammcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/nex-crm/wuphf/internal/openuiartifact"
)

var visualArtifactCreateGuidance = "Use for dense visual explainers, multi-section deep-dives, comparisons, reports, or review surfaces. NOT for short replies, status updates, acknowledgments, or coordination. The OpenUI artifact is the deliverable; do not duplicate it with notebook_write. After creating it, include visual-artifact:ra_0123456789abcdef on its own line in chat. Generate the openui_lang field using this exact contract:\n\n" + openuiartifact.SystemPrompt()

const visualArtifactReadGuidance = "Visual artifacts are OpenUI documents (with legacy HTML read compatibility). Reuse the returned visual-artifact:ra_... marker verbatim."

const visualArtifactPromoteGuidance = "Promote a reviewed visual artifact into the canonical team wiki. After a successful promote, broadcast the exact `card_broadcast` string returned by this tool via team_broadcast. Do NOT retype the artifact ID — copy the `card_marker` (`visual-artifact:ra_...`) verbatim from this tool's response."

// TeamVisualArtifactCreateArgs is the contract for
// visual_artifact_create.
type TeamVisualArtifactCreateArgs struct {
	MySlug            string   `json:"my_slug,omitempty" jsonschema:"Your agent slug. Defaults to WUPHF_AGENT_SLUG env."`
	TaskID            string   `json:"task_id,omitempty" jsonschema:"Task ID this visual artifact supports, when relevant."`
	SourcePath        string   `json:"source_path,omitempty" jsonschema:"OPTIONAL legacy field. Set ONLY when this artifact accompanies a pre-existing markdown notebook entry. Leave EMPTY for new OpenUI artifacts."`
	Title             string   `json:"title" jsonschema:"Short human-readable title for the visual artifact."`
	Summary           string   `json:"summary" jsonschema:"One or two sentence summary of what the artifact helps the human review."`
	OpenUILang        string   `json:"openui_lang" jsonschema:"A complete static OpenUI Lang v0.5 document using the WUPHF component contract in this tool description."`
	RelatedMessageID  string   `json:"related_message_id,omitempty" jsonschema:"Optional source message ID this artifact explains."`
	RelatedReceiptIDs []string `json:"related_receipt_ids,omitempty" jsonschema:"Optional receipt IDs this artifact explains."`
	CommitMsg         string   `json:"commit_message,omitempty" jsonschema:"Why this visual artifact exists - becomes the git commit message."`
}

// TeamVisualArtifactListArgs is the contract for
// visual_artifact_list.
type TeamVisualArtifactListArgs struct {
	TargetSlug string `json:"target_slug,omitempty" jsonschema:"Agent whose visual artifacts to list. Defaults to your own when source_path is omitted."`
	SourcePath string `json:"source_path,omitempty" jsonschema:"Optional notebook source path filter, like agents/{slug}/notebook/{filename}.md."`
}

// TeamVisualArtifactReadArgs is the contract for
// visual_artifact_read.
type TeamVisualArtifactReadArgs struct {
	ArtifactID string `json:"artifact_id" jsonschema:"Visual artifact ID returned by visual_artifact_create or visual_artifact_list, like ra_0123456789abcdef."`
}

// TeamVisualArtifactPromoteArgs is the contract for
// visual_artifact_promote.
type TeamVisualArtifactPromoteArgs struct {
	MySlug          string `json:"my_slug,omitempty" jsonschema:"Your agent slug. Defaults to WUPHF_AGENT_SLUG env."`
	ArtifactID      string `json:"artifact_id" jsonschema:"Visual artifact ID to promote, like ra_0123456789abcdef."`
	TargetWikiPath  string `json:"target_wiki_path" jsonschema:"Canonical wiki path - MUST start with team/ and end in .md."`
	MarkdownSummary string `json:"markdown_summary" jsonschema:"Canonical markdown article body to pair with the promoted visual artifact. Include the durable facts and links; the HTML remains the visual companion."`
	Mode            string `json:"mode,omitempty" jsonschema:"One of: create | replace | append_section. Defaults to create."`
	CommitMsg       string `json:"commit_message,omitempty" jsonschema:"Why this visual artifact is ready for the wiki - becomes the git commit message."`
}

func registerVisualArtifactTools(server *mcp.Server) {
	mcp.AddTool(server, officeWriteTool(
		"visual_artifact_create",
		"Create a static OpenUI artifact. "+visualArtifactCreateGuidance,
	), handleTeamVisualArtifactCreate)
	mcp.AddTool(server, readOnlyTool(
		"visual_artifact_list",
		"List visual artifacts authored by an agent so you can reuse, inspect, or promote them. "+visualArtifactReadGuidance,
	), handleTeamVisualArtifactList)
	mcp.AddTool(server, readOnlyTool(
		"visual_artifact_read",
		"Read one visual artifact and its metadata. Use before editing or promoting an existing artifact. "+visualArtifactReadGuidance,
	), handleTeamVisualArtifactRead)
	mcp.AddTool(server, officeWriteTool(
		"visual_artifact_promote",
		visualArtifactPromoteGuidance,
	), handleTeamVisualArtifactPromote)
}

func handleTeamVisualArtifactCreate(ctx context.Context, _ *mcp.CallToolRequest, args TeamVisualArtifactCreateArgs) (*mcp.CallToolResult, any, error) {
	slug, err := resolveSlug(args.MySlug)
	if err != nil {
		return toolError(err), nil, nil
	}
	// source_path is now optional. When set, it must point at an existing
	// markdown notebook entry owned by this agent (legacy companion mode).
	// When empty, the artifact is the canonical article on its own.
	sourcePath := strings.TrimSpace(args.SourcePath)
	if sourcePath != "" {
		if err := validateOwnedNotebookMarkdownPath(slug, sourcePath, "source_path"); err != nil {
			return toolError(err), nil, nil
		}
	}
	title := strings.TrimSpace(args.Title)
	if title == "" {
		return toolError(fmt.Errorf("title is required")), nil, nil
	}
	if strings.TrimSpace(args.OpenUILang) == "" {
		return toolError(fmt.Errorf("openui_lang is required")), nil, nil
	}

	var result map[string]any
	err = brokerPostJSON(ctx, "/visual-artifacts", map[string]any{
		"slug":                 slug,
		"title":                title,
		"summary":              strings.TrimSpace(args.Summary),
		"openui_lang":          args.OpenUILang,
		"source_markdown_path": sourcePath,
		"related_task_id":      strings.TrimSpace(args.TaskID),
		"related_message_id":   strings.TrimSpace(args.RelatedMessageID),
		"related_receipt_ids":  args.RelatedReceiptIDs,
		"commit_message":       strings.TrimSpace(args.CommitMsg),
	}, &result)
	if err != nil {
		return toolError(err), nil, nil
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return toolError(fmt.Errorf("marshal visual artifact create response: %w", err)), nil, nil
	}
	return textResult(string(payload)), nil, nil
}

func handleTeamVisualArtifactList(ctx context.Context, _ *mcp.CallToolRequest, args TeamVisualArtifactListArgs) (*mcp.CallToolResult, any, error) {
	q := url.Values{}
	sourcePath := strings.TrimSpace(args.SourcePath)
	if sourcePath != "" {
		if err := validateNotebookMarkdownPath(sourcePath, "source_path"); err != nil {
			return toolError(err), nil, nil
		}
		q.Set("source_path", sourcePath)
	}
	target := strings.TrimSpace(args.TargetSlug)
	if target == "" && sourcePath == "" {
		target = resolveSlugOptional("")
		if target == "" {
			return toolError(fmt.Errorf("target_slug is required (and WUPHF_AGENT_SLUG is not set)")), nil, nil
		}
	}
	if target != "" {
		q.Set("slug", target)
	}
	var result struct {
		Artifacts []map[string]any `json:"artifacts"`
	}
	path := "/visual-artifacts"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	if err := brokerGetJSON(ctx, path, &result); err != nil {
		return toolError(err), nil, nil
	}
	if result.Artifacts == nil {
		result.Artifacts = []map[string]any{}
	}
	payload, err := json.Marshal(result.Artifacts)
	if err != nil {
		return toolError(fmt.Errorf("marshal visual artifact list response: %w", err)), nil, nil
	}
	return textResult(string(payload)), nil, nil
}

func handleTeamVisualArtifactRead(ctx context.Context, _ *mcp.CallToolRequest, args TeamVisualArtifactReadArgs) (*mcp.CallToolResult, any, error) {
	id := strings.TrimSpace(args.ArtifactID)
	if err := validateRichArtifactIDLocal(id); err != nil {
		return toolError(err), nil, nil
	}
	var result map[string]any
	if err := brokerGetJSON(ctx, "/visual-artifacts/"+url.PathEscape(id)+"?accept_representation=openui", &result); err != nil {
		return toolError(err), nil, nil
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return toolError(fmt.Errorf("marshal visual artifact read response: %w", err)), nil, nil
	}
	return textResult(string(payload)), nil, nil
}

func handleTeamVisualArtifactPromote(ctx context.Context, _ *mcp.CallToolRequest, args TeamVisualArtifactPromoteArgs) (*mcp.CallToolResult, any, error) {
	slug, err := resolveSlug(args.MySlug)
	if err != nil {
		return toolError(err), nil, nil
	}
	id := strings.TrimSpace(args.ArtifactID)
	if err := validateRichArtifactIDLocal(id); err != nil {
		return toolError(err), nil, nil
	}
	targetPath := strings.TrimSpace(args.TargetWikiPath)
	if !strings.HasPrefix(targetPath, "team/") {
		return toolError(fmt.Errorf("target_wiki_path %q must start with team/", targetPath)), nil, nil
	}
	if !strings.HasSuffix(strings.ToLower(targetPath), ".md") {
		return toolError(fmt.Errorf("target_wiki_path must end in .md; got %q", targetPath)), nil, nil
	}
	markdown := strings.TrimSpace(args.MarkdownSummary)
	if markdown == "" {
		return toolError(fmt.Errorf("markdown_summary is required")), nil, nil
	}
	mode := strings.TrimSpace(args.Mode)
	if mode == "" {
		mode = "create"
	}
	switch mode {
	case "create", "replace", "append_section":
	default:
		return toolError(fmt.Errorf("mode must be one of create | replace | append_section; got %q", mode)), nil, nil
	}

	var result map[string]any
	err = brokerPostJSON(ctx, "/visual-artifacts/"+url.PathEscape(id)+"/promote", map[string]any{
		"actor_slug":       slug,
		"target_wiki_path": targetPath,
		"markdown_summary": markdown,
		"mode":             mode,
		"commit_message":   strings.TrimSpace(args.CommitMsg),
	}, &result)
	if err != nil {
		return toolError(err), nil, nil
	}
	// Return a pre-composed broadcast string the agent can paste verbatim into
	// team_broadcast. The marker MUST stay as a single token on its own line
	// because the frontend parser keys off the full 16-hex-char ID — agents
	// retyping the ID is the load-bearing failure mode this contract avoids.
	// See web/src/components/messages/MessageArtifactReferences.tsx for the
	// parser side.
	marker := "visual-artifact:" + id
	// displayTitle is agent-controlled (it comes from the promote result's
	// artifact.title or a path fallback). It is interpolated into a
	// precomposed card_broadcast string the agent is told to paste verbatim
	// into team_broadcast. Newlines, backticks, or an embedded
	// `visual-artifact:` marker in the title could spoof a second card or
	// break the single-line marker contract the frontend parser keys off.
	// Normalize before composing so the title can never inject structure.
	displayTitle := normalizeArtifactCardTitle(artifactTitleFromPromoteResult(result, targetPath))
	cardBroadcast := fmt.Sprintf(
		"Saved \"%s\" to the wiki at `%s`.\n\n%s",
		displayTitle,
		targetPath,
		marker,
	)
	if result == nil {
		result = map[string]any{}
	}
	result["card_broadcast"] = cardBroadcast
	result["card_marker"] = marker
	payload, err := json.Marshal(result)
	if err != nil {
		return toolError(fmt.Errorf("marshal visual artifact promote response: %w", err)), nil, nil
	}
	return textResult(string(payload)), nil, nil
}

// artifactTitleFromPromoteResult extracts a human title from the promote
// response so the broadcast card can read "Saved <title> to the wiki at
// <path>" instead of just echoing the ID. Falls back to a path-derived
// title when the broker response omits artifact.title.
func artifactTitleFromPromoteResult(result map[string]any, targetWikiPath string) string {
	if result != nil {
		if artifact, ok := result["artifact"].(map[string]any); ok {
			if t, ok := artifact["title"].(string); ok {
				if title := strings.TrimSpace(t); title != "" {
					return title
				}
			}
		}
	}
	target := strings.TrimSpace(targetWikiPath)
	if idx := strings.LastIndex(target, "/"); idx >= 0 {
		target = target[idx+1:]
	}
	target = strings.TrimSuffix(target, ".md")
	target = strings.ReplaceAll(target, "-", " ")
	target = strings.ReplaceAll(target, "_", " ")
	title := strings.TrimSpace(target)
	if title == "" {
		return "the visual artifact"
	}
	return title
}

// normalizeArtifactCardTitle neutralizes an agent-controlled title before it is
// interpolated into the precomposed card_broadcast string. The card relies on
// the `visual-artifact:<id>` marker being a single token on its own line for
// the frontend parser (web/src/components/messages/MessageArtifactReferences.tsx).
// A title carrying newlines, backticks, or its own `visual-artifact:` substring
// could spoof a second card or break the marker line, so:
//   - all whitespace runs (including newlines/tabs) collapse to a single space,
//   - any `visual-artifact:` substring (case-insensitive) is defanged so it can
//     no longer be parsed as a marker, and
//   - backticks are replaced with single quotes so the title cannot open or
//     close the code span around the wiki path.
func normalizeArtifactCardTitle(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	// Defang any visual-artifact: marker spoof, case-insensitively. Replacing
	// the colon with a space breaks the `marker:id` token the parser matches
	// while keeping the words readable.
	for {
		idx := indexFoldASCII(s, "visual-artifact:")
		if idx < 0 {
			break
		}
		colon := idx + len("visual-artifact:") - 1
		s = s[:colon] + " " + s[colon+1:]
	}
	s = strings.ReplaceAll(s, "`", "'")
	s = strings.TrimSpace(s)
	if s == "" {
		return "the visual artifact"
	}
	return s
}

// indexFoldASCII returns the index of the first case-insensitive (ASCII)
// occurrence of token in s, or -1. token is assumed lowercase ASCII.
func indexFoldASCII(s, token string) int {
	if token == "" {
		return 0
	}
	if len(token) > len(s) {
		return -1
	}
	for i := 0; i <= len(s)-len(token); i++ {
		match := true
		for j := 0; j < len(token); j++ {
			c := s[i+j]
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != token[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func validateOwnedNotebookMarkdownPath(slug, path, field string) error {
	if err := validateNotebookMarkdownPath(path, field); err != nil {
		return err
	}
	expectedPrefix := "agents/" + slug + "/notebook/"
	if !strings.HasPrefix(path, expectedPrefix) {
		return fmt.Errorf("%s %q must start with %s", field, path, expectedPrefix)
	}
	return nil
}

func validateNotebookMarkdownPath(path, field string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("%s is required", field)
	}
	if !strings.HasPrefix(path, "agents/") || !strings.Contains(path, "/notebook/") {
		return fmt.Errorf("%s %q must be a notebook path like agents/{slug}/notebook/{filename}.md", field, path)
	}
	if !strings.HasSuffix(strings.ToLower(path), ".md") {
		return fmt.Errorf("%s must end in .md; got %q", field, path)
	}
	return nil
}

func validateRichArtifactIDLocal(id string) error {
	if len(id) != len("ra_")+16 || !strings.HasPrefix(id, "ra_") {
		return fmt.Errorf("artifact_id must look like ra_0123456789abcdef; got %q", id)
	}
	for _, ch := range strings.TrimPrefix(id, "ra_") {
		if !((ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9')) {
			return fmt.Errorf("artifact_id must look like ra_0123456789abcdef; got %q", id)
		}
	}
	return nil
}
