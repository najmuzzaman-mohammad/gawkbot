/**
 * Chat tab — a pure DM conversation with this bot.
 *
 * The subspace gives Tasks, Skills, Policies, Live Stream, and Config their own
 * tabs, so the Chat tab is JUST chat: no workbench, no activity rail. It reuses
 * the shared channel primitives — `MessageFeed` (stream + typing loader +
 * threads + reactions + mentions + slash commands + date separators) and
 * `Composer` — pointed at the bot's canonical DM channel, so it stays at
 * feature parity with the channel view by construction. Human-interview cards
 * still surface here via the globally-mounted `InterviewBar` in `Shell`.
 */

import type { OfficeMember } from "../../../api/client";
import { directChannelSlug } from "../../../stores/app";
import { Composer } from "../../messages/Composer";
import { MessageFeed } from "../../messages/MessageFeed";

interface ChatTabProps {
  agent: OfficeMember;
}

export function ChatTab({ agent }: ChatTabProps) {
  const channelSlug = directChannelSlug(agent.slug);
  return (
    <section
      className="bot-subspace-tab-content bot-chat-tab conversation-chat"
      aria-label={`Chat with @${agent.slug}`}
      data-testid="bot-chat-tab"
    >
      <MessageFeed channel={channelSlug} />
      <Composer channel={channelSlug} />
    </section>
  );
}
