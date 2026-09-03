package teammcp

import (
	"context"
	"fmt"
	"strings"
)

// requireTeamMemberApproval gates bot-initiated office-member creation behind
// a blocking human approval. Spinning up a new specialist is a durable,
// cost-incurring, persistent act, so a bot (the CEO included) may PROPOSE a
// new member, but a human must approve before it is created.
//
// The card and polling live in requireHumanCreateApproval (create_approval.go),
// shared with the channel gate so the two cannot drift.
//
// Returns nil when approved (the caller then creates the member). Returns a
// descriptive error on reject / hold / cancel / timeout so the bot routes to
// "reuse an existing specialist instead" rather than retrying the create.
func requireTeamMemberApproval(ctx context.Context, actor string, args TeamMemberArgs) error {
	slug := normalizeSlug(args.Slug)
	actor = strings.TrimSpace(actor)
	if actor == "" {
		actor = "ceo"
	}
	name := strings.TrimSpace(args.Name)
	if name == "" {
		name = slug
	}
	role := strings.TrimSpace(args.Role)

	ctxLines := []string{
		fmt.Sprintf("@%s wants to add a NEW office member (a new bot, not a task).", actor),
		fmt.Sprintf("- Slug: %s", slug),
		fmt.Sprintf("- Name: %s", name),
	}
	if role != "" {
		ctxLines = append(ctxLines, fmt.Sprintf("- Role: %s", role))
	}
	if len(args.Expertise) > 0 {
		ctxLines = append(ctxLines, fmt.Sprintf("- Expertise: %s", strings.Join(args.Expertise, ", ")))
	}
	if p := strings.TrimSpace(args.Personality); p != "" {
		ctxLines = append(ctxLines, fmt.Sprintf("- Personality: %s", p))
	}
	if pk := strings.TrimSpace(args.Provider); pk != "" {
		runtime := pk
		if m := strings.TrimSpace(args.Model); m != "" {
			runtime += " / " + m
		}
		ctxLines = append(ctxLines, fmt.Sprintf("- Runtime: %s", runtime))
	}
	ctxLines = append(ctxLines, "Approve only if no existing teammate can cover this work. Rejecting keeps the roster unchanged; the requester should reuse an existing specialist.")

	question := fmt.Sprintf("Add %s (@%s) to the team?", name, slug)
	if role != "" {
		question = fmt.Sprintf("Add %s (@%s, %s) to the team?", name, slug, role)
	}

	return requireHumanCreateApproval(ctx, createApproval{
		Actor:     actor,
		Subject:   "@" + slug,
		Title:     fmt.Sprintf("Approve new specialist @%s?", slug),
		Question:  question,
		Context:   ctxLines,
		DedupeKey: "member-create:" + slug,
		Guidance:  "assign this work to an existing specialist instead",
	})
}
