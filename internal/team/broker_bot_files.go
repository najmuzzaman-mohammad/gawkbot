package team

import (
	"context"
	"log"
	"strings"
	"time"
)

// broker_agent_files.go wires the per-bot instruction file set (SOUL /
// IDENTITY / OPERATIONS / TOOLS + office USER) into the broker: reads for the
// prompt builder, and a deterministic backfill that seeds the files for every
// bot in the roster. See agent_files.go for the storage + generation layer.

// ReadBotInstruction returns the content of one of a bot's instruction
// files (name = SOUL|IDENTITY|OPERATIONS|TOOLS), or "" when the wiki backend is
// off or the file is absent. Safe for the prompt hot path (single disk read
// under the repo lock).
func (b *Broker) ReadBotInstruction(slug, name string) string {
	slug = strings.TrimSpace(slug)
	if slug == "" || !isBotInstructionFileName(strings.TrimSpace(name)) {
		return ""
	}
	worker := b.WikiWorker()
	if worker == nil {
		return ""
	}
	data, err := worker.BotFileRead(botFileRel(slug, name))
	if err != nil || len(data) == 0 {
		return ""
	}
	return string(data)
}

// ReadOfficeUserFile returns the office-wide USER.md content, or "" when absent.
func (b *Broker) ReadOfficeUserFile() string {
	worker := b.WikiWorker()
	if worker == nil {
		return ""
	}
	data, err := worker.BotFileRead(officeUserFileRel)
	if err != nil || len(data) == 0 {
		return ""
	}
	return string(data)
}

// backfillBotFilesForRoster seeds any MISSING instruction file for every bot
// in the roster (plus the office USER.md) with deterministic content derived
// from the bot's current persona/role/expertise/tools. Idempotent: existing
// files are never overwritten, so a human's edits survive. Runs on every
// roster-ensure hook so new bots and fresh offices get their files
// without an LLM call (which could half-initialize a bot on failure).
func (b *Broker) backfillBotFilesForRoster() {
	worker := b.WikiWorker()
	if worker == nil {
		return
	}
	members := b.OfficeMembers()
	if len(members) == 0 {
		return
	}
	leadSlug, _ := leadSlugAndName(members)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	writeIfAbsent := func(author, relPath, content string) {
		if strings.TrimSpace(content) == "" {
			return
		}
		if existing, err := worker.BotFileRead(relPath); err == nil && len(existing) > 0 {
			return // never clobber existing content (human edits or prior seed)
		}
		if _, _, err := worker.BotFileWrite(ctx, author, relPath, content, "create", "bot: seed "+relPath); err != nil {
			// A create race ("already exists") or a transient git error is
			// non-fatal: the next roster-ensure retries, and a present file is
			// the desired end state anyway.
			if !strings.Contains(err.Error(), "already exists") {
				log.Printf("bot file: seed %s failed: %v", relPath, err)
			}
		}
	}

	seen := make(map[string]struct{}, len(members))
	for _, member := range members {
		slug := strings.TrimSpace(member.Slug)
		if slug == "" {
			continue
		}
		if _, ok := seen[slug]; ok {
			continue
		}
		seen[slug] = struct{}{}
		isLead := slug == strings.TrimSpace(leadSlug)
		writeIfAbsent(slug, botFileRel(slug, "SOUL"), renderBotSoul(member, isLead))
		writeIfAbsent(slug, botFileRel(slug, "IDENTITY"), renderBotIdentity(member))
		writeIfAbsent(slug, botFileRel(slug, "OPERATIONS"), renderBotOperations(member, isLead))
		writeIfAbsent(slug, botFileRel(slug, "TOOLS"), renderBotTools(member))
	}

	// Office-wide human-context file (one per office), authored by the lead or
	// a bootstrap identity.
	author := strings.TrimSpace(leadSlug)
	if author == "" {
		author = "wuphf-bootstrap"
	}
	writeIfAbsent(author, officeUserFileRel, renderOfficeUserFile())
}
