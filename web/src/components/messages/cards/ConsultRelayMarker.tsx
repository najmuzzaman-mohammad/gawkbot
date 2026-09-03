/**
 * ConsultRelayMarker — the quiet line in your DM showing that your bot went
 * and talked to another bot.
 *
 *   ── Messaged  (avatar) Bagel Social ──
 *   ── Message from  (avatar) Bagel Social ──
 *
 * It is deliberately NOT a message bubble: no bubble background, no left/right
 * alignment, no author. It reads as a divider, like the date separator it
 * borrows its treatment from. Nobody said this — it is an event, and the row
 * has no sender to render.
 *
 * Clicking opens that bot-to-bot conversation READ-ONLY. You can see what
 * was said; you cannot post into it, and there is no composer to suggest you
 * could. That is the point of the whole feature: if your bot tells you
 * "Social says X", you can check whether it actually asked.
 *
 * The marker is derived server-side from the real bot-to-bot message
 * (internal/team/broker_consult_relay.go), so it cannot be fabricated by an
 * bot claiming a consult it never had.
 */

import { useState } from "react";

import "../../../styles/consult-relay.css";

import { useOfficeMembers } from "../../../hooks/useMembers";
import { PixelAvatar } from "../../ui/PixelAvatar";
import { SidePanel } from "../../ui/SidePanel";
import { MessageFeed } from "../MessageFeed";

export interface ConsultRelayPayload {
  /** Relative to the bot whose DM this appears in. */
  direction?: "sent" | "received";
  /** The OTHER bot — the one named on the marker. */
  agent?: string;
  /** The bot-to-bot DM channel, so the click has somewhere to go. */
  channel?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseConsultRelayPayload(raw: unknown): ConsultRelayPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: ConsultRelayPayload = {};
  if (r.direction === "sent" || r.direction === "received") {
    out.direction = r.direction;
  }
  if (isNonEmptyString(r.agent)) out.agent = r.agent.trim();
  if (isNonEmptyString(r.channel)) out.channel = r.channel.trim();
  return out;
}

export interface ConsultRelayMarkerProps {
  payload: ConsultRelayPayload;
}

export function ConsultRelayMarker({ payload }: ConsultRelayMarkerProps) {
  const [open, setOpen] = useState(false);
  const { data: members = [] } = useOfficeMembers();

  const slug = payload.agent ?? "";
  const channel = payload.channel ?? "";
  // A marker with no peer is not renderable as anything meaningful, and
  // inventing a name would be worse than showing nothing.
  if (!slug) return null;

  const name = members.find((m) => m.slug === slug)?.name || slug;
  const verb = payload.direction === "received" ? "Message from" : "Messaged";
  const canOpen = channel.length > 0;

  return (
    <div className="consult-relay-row">
      <button
        type="button"
        className="consult-relay"
        data-testid="consult-relay-marker"
        data-direction={payload.direction ?? "sent"}
        data-bot-slug={slug}
        onClick={() => setOpen(true)}
        disabled={!canOpen}
        aria-label={`${verb} ${name} — open the conversation, read only`}
      >
        <span className="consult-relay-verb">{verb}</span>
        <PixelAvatar slug={slug} size={16} />
        <span className="consult-relay-agent">{name}</span>
      </button>

      {canOpen ? (
        <SidePanel
          open={open}
          onClose={() => setOpen(false)}
          title={name}
          subtitle="Read only — you are not in this conversation"
        >
          {/* MessageFeed carries no composer of its own; every other caller
              pairs it with a sibling <Composer/>. Read-only here is therefore
              structural — there is nothing to submit, rather than a submit
              that has been disabled. `readOnly` additionally suppresses
              reactions, which are a mark you leave on someone else's
              conversation. */}
          <MessageFeed channel={channel} readOnly={true} />
        </SidePanel>
      ) : null}
    </div>
  );
}
