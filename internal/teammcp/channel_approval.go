package teammcp

import (
	"context"
	"fmt"
	"strings"
)

// requireTeamChannelApproval gates bot-initiated office-channel creation
// behind a blocking human approval, exactly like the member gate.
//
// Why: a channel is durable office structure, not a per-task artifact. The CEO
// deciding on its own that the office needs #growth, #launch, and #ops leaves
// the human with a sidebar they did not ask for and did not agree to maintain.
// Before this gate the only restraint on team_channel was prompt wording ("Only
// do this when the human explicitly wants channel structure"), which is
// guidance, not a control — the tool created the channel the moment the model
// called it. Now the CEO proposes and the human decides, the same way it must
// for a new teammate.
//
// Scope: office channels created through the bot-facing team_channel tool
// with action="create". NOT gated, because none of these are the CEO inventing
// structure: DMs (team_dm_open -> /channels/dm), the roster/channels seeded
// from the onboarding blueprint
// the human picked in the wizard, and any channel a human creates in the UI
// (which posts to /channels directly and never reaches this path).
//
// Returns nil when approved (the caller then creates the channel). Returns a
// descriptive error on reject / hold / cancel / timeout so the bot posts in an
// existing channel instead of retrying the create.
func requireTeamChannelApproval(ctx context.Context, actor string, args TeamChannelArgs) error {
	slug := normalizeSlug(args.Channel)
	actor = strings.TrimSpace(actor)
	if actor == "" {
		actor = "ceo"
	}
	name := strings.TrimSpace(args.Name)
	if name == "" {
		name = slug
	}

	ctxLines := []string{
		fmt.Sprintf("@%s wants to create a NEW office channel (durable structure, not a task).", actor),
		fmt.Sprintf("- Slug: #%s", slug),
	}
	if name != slug {
		ctxLines = append(ctxLines, fmt.Sprintf("- Name: %s", name))
	}
	if d := strings.TrimSpace(args.Description); d != "" {
		ctxLines = append(ctxLines, fmt.Sprintf("- For: %s", d))
	} else {
		ctxLines = append(ctxLines, "- For: (no description given)")
	}
	if len(args.Members) > 0 {
		ctxLines = append(ctxLines, fmt.Sprintf("- Initial roster: %s", strings.Join(args.Members, ", ")))
	}
	ctxLines = append(ctxLines, "Approve only if this work does not belong in a channel that already exists. Rejecting keeps the sidebar unchanged; the requester should use an existing channel.")

	return requireHumanCreateApproval(ctx, createApproval{
		Actor:     actor,
		Subject:   "#" + slug,
		Title:     fmt.Sprintf("Approve new channel #%s?", slug),
		Question:  fmt.Sprintf("Create the #%s channel?", slug),
		Context:   ctxLines,
		DedupeKey: "channel-create:" + slug,
		Guidance:  "post in an existing channel instead",
	})
}
