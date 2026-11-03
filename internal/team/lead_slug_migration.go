package team

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"regexp"
)

// The lead bot's slug was "ceo" until 2026-09-03. The bot is the Chief of
// Staff and the founder is the CEO, so its tag is "cos" now. Everything in
// this file keeps old state files, old on-disk directories, and old callers
// (prompts, configs, MCP clients still saying "ceo") working.

// LeadSlug is the lead bot's slug.
const LeadSlug = "cos"

// legacyLeadSlug is the slug the lead bot had before the rename.
const legacyLeadSlug = "ceo"

// Only the slug itself moves: a standalone "ceo" token, and the two DM-slug
// forms "ceo__x" / "x__ceo". Card kinds ("ceo_checklist"), CSS classes
// ("ceo-card"), and identifiers stay as they are.
var legacyLeadSlugPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(^|[^A-Za-z0-9_-])ceo($|[^A-Za-z0-9_-])`),
	regexp.MustCompile(`(^|[^A-Za-z0-9_-])ceo(__)`),
	regexp.MustCompile(`(__)ceo($|[^A-Za-z0-9_-])`),
	// Scheduler job keys encode the DM channel with "--" instead of "__"
	// ("task-follow-up:ceo--human:task-skill-31").
	regexp.MustCompile(`(:)ceo(--)`),
	regexp.MustCompile(`(--)ceo(:|$)`),
}

// migrateLegacyLeadSlug rewrites every legacy lead slug in s to LeadSlug.
func migrateLegacyLeadSlug(s string) string {
	if !bytes.Contains([]byte(s), []byte(legacyLeadSlug)) {
		return s
	}
	for _, re := range legacyLeadSlugPatterns {
		// Run twice: adjacent matches share a boundary character, and a
		// single pass consumes it ("ceo ceo" → "cos ceo").
		s = re.ReplaceAllString(s, "${1}"+LeadSlug+"${2}")
		s = re.ReplaceAllString(s, "${1}"+LeadSlug+"${2}")
	}
	return s
}

// migrateLegacyLeadSlugBytes is migrateLegacyLeadSlug for a raw state file.
// It runs before the JSON is decoded so every slug-bearing field — members,
// channels, message senders and mentions, task owners, ledgers, requests,
// scheduler entries — moves in one place instead of one field at a time.
func migrateLegacyLeadSlugBytes(data []byte) []byte {
	if !bytes.Contains(data, []byte(legacyLeadSlug)) {
		return data
	}
	return []byte(migrateLegacyLeadSlug(string(data)))
}

// migrateLegacyLeadSlugDir renames <parent>/ceo to <parent>/cos when the old
// directory exists and the new one does not. Used for the per-bot scratch
// dir and the wiki's agents/ tree. Best effort: a failure is logged, never
// fatal, because the office must still boot.
func migrateLegacyLeadSlugDir(parent string) {
	if parent == "" {
		return
	}
	oldPath := filepath.Join(parent, legacyLeadSlug)
	newPath := filepath.Join(parent, LeadSlug)
	if _, err := os.Stat(oldPath); err != nil {
		return
	}
	if _, err := os.Stat(newPath); err == nil {
		return
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		log.Printf("lead slug migration: rename %s -> %s failed: %v", oldPath, newPath, err)
		return
	}
	log.Printf("lead slug migration: renamed %s -> %s", oldPath, newPath)
}

// migrateLegacyLeadSlugFile renames <dir>/ceo<ext> to <dir>/cos<ext> under
// the same rules as migrateLegacyLeadSlugDir.
func migrateLegacyLeadSlugFile(dir, ext string) {
	if dir == "" {
		return
	}
	oldPath := filepath.Join(dir, legacyLeadSlug+ext)
	newPath := filepath.Join(dir, LeadSlug+ext)
	if _, err := os.Stat(oldPath); err != nil {
		return
	}
	if _, err := os.Stat(newPath); err == nil {
		return
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		log.Printf("lead slug migration: rename %s -> %s failed: %v", oldPath, newPath, err)
	}
}
