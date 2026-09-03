package team

import (
	"context"
	"testing"

	"github.com/slack-go/slack/slackevents"

	"github.com/nex-crm/wuphf/internal/provider"
)

// addSpawnedMember seeds a completed spawned bot directly onto the roster:
// a real office bot (default runtime) carrying its own Slack identity.
func addSpawnedMember(t *testing.T, b *Broker, slug, userID, tokenEnv string) {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	b.members = append(b.members, officeMember{
		Slug: slug,
		Name: humanizeSlug(slug),
		Provider: provider.ProviderBinding{
			Slack: &provider.SlackProviderBinding{UserID: userID, BotTokenEnv: tokenEnv},
		},
	})
}

// The ECHO GUARD: a spawned bot's Slack posts are office-originated (Send
// posts them with the bot's own token), so inbound messages authored by its
// bot user id must be dropped — in BOTH shapes they can arrive in: classic
// bot_message subtypes and plain user-authored events.
func TestSlackRouteInboundDropsSpawnedBotEcho(t *testing.T) {
	api := newFakeSlackAPI()
	tr, b := newTestSlackTransport(t, "C0123", api)
	addSpawnedMember(t, b, "researcher", "U555", "WUPHF_SLACK_AGENT_RESEARCHER_TOKEN")
	host := &brokerTransportHost{broker: b}

	cases := []struct {
		name string
		msg  *slackevents.MessageEvent
	}{
		{"bot_message subtype", &slackevents.MessageEvent{User: "U555", BotID: "B9", SubType: "bot_message", Channel: "C0123", Text: "echo", TimeStamp: "1"}},
		{"bot_id only", &slackevents.MessageEvent{User: "U555", BotID: "B9", Channel: "C0123", Text: "echo", TimeStamp: "2"}},
		{"plain user shape", &slackevents.MessageEvent{User: "U555", Channel: "C0123", Text: "echo", TimeStamp: "3"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tr.routeInbound(context.Background(), host, tc.msg); err != nil {
				t.Fatalf("routeInbound: %v", err)
			}
		})
	}
	if msgs := b.ChannelMessages("slack-general"); len(msgs) != 0 {
		t.Fatalf("spawned bot echo must be dropped, got %d messages", len(msgs))
	}

	// Contrast: a registered FOREIGN bot's bot posts still flow inbound.
	if _, err := b.RegisterSlackBot("claude-bot", "Claude Bot", "U777"); err != nil {
		t.Fatalf("RegisterSlackBot: %v", err)
	}
	foreign := &slackevents.MessageEvent{User: "U777", BotID: "B7", SubType: "bot_message", Channel: "C0123", Text: "foreign hello", TimeStamp: "4"}
	if err := tr.routeInbound(context.Background(), host, foreign); err != nil {
		t.Fatalf("routeInbound foreign: %v", err)
	}
	msgs := b.ChannelMessages("slack-general")
	if len(msgs) != 1 || msgs[0].From != "claude-bot" {
		t.Fatalf("foreign bot ingress regressed: %+v", msgs)
	}
}

// Outbound posting-as-the-bot: a spawned sender's message is carried to
// Send via the Participant field and posted with the BOT'S client, so it
// appears in Slack as that bot; every other sender uses the main bot.
func TestSlackSendPostsAsSpawnedBot(t *testing.T) {
	mainAPI := newFakeSlackAPI()
	tr, b := newTestSlackTransport(t, "C0123", mainAPI)
	addSpawnedMember(t, b, "researcher", "U555", "WUPHF_SLACK_AGENT_RESEARCHER_TOKEN")
	botAPI := newFakeSlackAPI()
	tr.spawnedClients.Store("researcher", slackAPI(botAPI))

	out, ok := tr.FormatOutbound(channelMessage{Channel: "slack-general", From: "researcher", Content: "findings ready"})
	if !ok {
		t.Fatal("FormatOutbound should map the bridged channel")
	}
	if out.Participant.Key != "spawned:researcher" || out.Participant.AdapterName != "slack" {
		t.Fatalf("participant = %+v, want spawned:researcher carrier", out.Participant)
	}
	// Internal members carry no "*Name*:" attribution — the bot's own
	// Slack identity is the speaker.
	if got := out.Text; got != "findings ready" {
		t.Fatalf("text = %q, want bare content", got)
	}
	if err := tr.Send(context.Background(), out); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if posts := botAPI.snapshotPosts(); len(posts) != 1 || posts[0].Text != "findings ready" {
		t.Fatalf("bot client posts = %+v, want the spawned bot's message", posts)
	}
	if posts := mainAPI.snapshotPosts(); len(posts) != 0 {
		t.Fatalf("main bot must not post a spawned bot's message, got %+v", posts)
	}

	// An ordinary office sender still posts via the main bot.
	out2, ok := tr.FormatOutbound(channelMessage{Channel: "slack-general", From: "ceo", Content: "status?"})
	if !ok {
		t.Fatal("FormatOutbound (ceo) should map")
	}
	if out2.Participant.Key != "" {
		t.Fatalf("ceo outbound should carry no spawned participant, got %+v", out2.Participant)
	}
	if err := tr.Send(context.Background(), out2); err != nil {
		t.Fatalf("Send (ceo): %v", err)
	}
	if posts := mainAPI.snapshotPosts(); len(posts) != 1 {
		t.Fatalf("main bot posts = %+v, want exactly the ceo message", posts)
	}
}

// spawnedBotClient builds the per-bot client from the env-var NAME on the
// member binding — and degrades to nil (→ main bot token) when unset.
func TestSpawnedAgentClient_FromEnv(t *testing.T) {
	api := newFakeSlackAPI()
	tr, b := newTestSlackTransport(t, "C0123", api)
	addSpawnedMember(t, b, "researcher", "U555", "WUPHF_SLACK_AGENT_RESEARCHER_TOKEN")
	addSpawnedMember(t, b, "writer", "U556", "WUPHF_SLACK_AGENT_WRITER_TOKEN")

	t.Setenv("WUPHF_SLACK_AGENT_RESEARCHER_TOKEN", "bot-token-test-555")
	if c := tr.spawnedBotClient("researcher"); c == nil {
		t.Fatal("expected a client when the token env is set")
	}
	// Env unset → nil, and Send falls back to the main client.
	if c := tr.spawnedBotClient("writer"); c != nil {
		t.Fatal("expected nil client when the token env is unset")
	}
	if got := tr.postClientFor(tr.spawnedSenderParticipant("writer")); got != slackAPI(api) {
		t.Fatal("postClientFor must fall back to the main client on a token miss")
	}
	// Not a spawned bot at all → zero participant → main client.
	if p := tr.spawnedSenderParticipant("ceo"); p.Key != "" {
		t.Fatalf("ceo should not resolve as spawned, got %+v", p)
	}
}
