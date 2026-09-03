package teammcp

import (
	"context"
	"fmt"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/nex-crm/wuphf/internal/channel"
)

// agent_message — one bot sends one direct message to one peer.
//
// Deliberately the smallest thing that works. It sends and returns. It does
// not wait for a reply, does not poll, and does not report back: that is the
// consult primitive, and it is a separate piece of work. What this exists for
// is to make bot-to-bot conversation possible at all, so the consult relay
// markers in the human's DM (broker_consult_relay.go) have something real to
// derive from.
//
// SECURITY POSTURE — this bypasses nothing.
//
// The send goes over the same POST /messages the web composer uses. That means
// canAccessChannelLocked gates it exactly as it gates a human's DM post: the
// sender reaches the pair DM because it is one of the two Members, never
// because it is exempt. The recipient must be a real roster member, so an
// bot cannot mint a conversation with an invented peer. The notifier then
// delivers to the DM partner by the same path as any other DM.
//
// No prompt anywhere instructs a bot to use this. That is intentional: the
// mechanism should be observable and safe before anything is told to reach for
// it.

// BotMessageArgs is the tool's input.
type BotMessageArgs struct {
	To      string `json:"to" jsonschema:"Slug of the teammate to message directly. Must be an existing bot from the roster."`
	Content string `json:"content" jsonschema:"What to say to them. One message; this does not wait for a reply."`
	MySlug  string `json:"my_slug,omitempty" jsonschema:"Bot slug sending the message. Defaults to WUPHF_AGENT_SLUG."`
}

func handleBotMessage(ctx context.Context, _ *mcp.CallToolRequest, args BotMessageArgs) (*mcp.CallToolResult, any, error) {
	from, err := resolveSlug(args.MySlug)
	if err != nil {
		return toolError(err), nil, nil
	}
	to := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(args.To), "@")))
	if to == "" {
		return textResult("Name the teammate to message (`to`)."), nil, nil
	}
	content := strings.TrimSpace(args.Content)
	if content == "" {
		return textResult("Nothing to send — `content` was empty."), nil, nil
	}
	if to == strings.ToLower(strings.TrimSpace(from)) {
		return textResult("That is you. Pick a different teammate."), nil, nil
	}

	// The recipient must exist. Checked against the roster the bot can
	// already see (the AVAILABLE BOTS directory is public), so this refuses
	// invented peers without hiding who is real.
	known, err := botRosterSlugs(ctx)
	if err != nil {
		return toolError(err), nil, nil
	}
	if _, ok := known[to]; !ok {
		names := make([]string, 0, len(known))
		for slug := range known {
			names = append(names, "@"+slug)
		}
		return textResult(fmt.Sprintf(
			"There is no teammate @%s. The team has: %s.",
			to, strings.Join(names, ", "),
		)), nil, nil
	}

	// The pair DM slug is deterministic and order-independent, so both bots
	// address the same conversation regardless of who opens it.
	dm := channel.DirectSlug(strings.ToLower(strings.TrimSpace(from)), to)

	var result struct {
		ID string `json:"id"`
	}
	if err := brokerPostJSON(ctx, "/messages", map[string]any{
		"channel": dm,
		"from":    from,
		"content": content,
	}, &result); err != nil {
		return toolError(err), nil, nil
	}

	text := fmt.Sprintf("Messaged @%s directly. They will see it in their DMs; this does not wait for a reply.", to)
	if result.ID != "" {
		text += " (" + result.ID + ")"
	}
	return textResult(text), nil, nil
}

// botRosterSlugs returns the set of real bot slugs, lowercased.
func botRosterSlugs(ctx context.Context) (map[string]struct{}, error) {
	var result brokerOfficeMembersResponse
	if err := brokerGetJSON(ctx, "/office-members", &result); err != nil {
		return nil, err
	}
	out := make(map[string]struct{}, len(result.Members))
	for _, m := range result.Members {
		if slug := strings.ToLower(strings.TrimSpace(m.Slug)); slug != "" {
			out[slug] = struct{}{}
		}
	}
	return out, nil
}
