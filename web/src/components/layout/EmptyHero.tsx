import type { OfficeMember } from "../../api/client";
import { useOfficeMembers } from "../../hooks/useMembers";
import { directChannelSlug } from "../../lib/channels";
import { PixelAvatar } from "../ui/PixelAvatar";

/** Rendered size of the hero mark. */
export const EMPTY_HERO_AVATAR_SIZE = 72;

interface EmptyHeroProps {
  /** The bot whose empty surface this is. */
  slug: string;
  /** One short, friendly line. Omit when the surrounding copy already is one. */
  line?: string;
}

/**
 * A bot's big face over an empty surface: its DM before the first message,
 * its task board before the first task.
 *
 * Theme-gated, not theme-agnostic. It renders in every theme but is
 * `display: none` unless the active theme sets `--empty-hero-display`
 * (messages.css); today only Soft does. That keeps every other theme's empty
 * states exactly as they were, and lets Soft hide the long-form copy beside
 * it with a `:has(.empty-hero)` rule instead of a second set of markup.
 */
export function EmptyHero({ slug, line }: EmptyHeroProps) {
  // The roster is already cached by the sidebar; this is a cache read that
  // gives the hero the bot's chosen look rather than the slug-derived one.
  const { data: members = [] } = useOfficeMembers();
  const member = members.find((m) => m.slug === slug);
  return (
    <div className="empty-hero" data-testid="empty-hero">
      <span className="empty-hero-avatar" aria-hidden="true">
        <PixelAvatar
          slug={slug}
          size={EMPTY_HERO_AVATAR_SIZE}
          avatar={member?.avatar}
        />
      </span>
      {line ? <span className="empty-hero-line">{line}</span> : null}
    </div>
  );
}

/**
 * The roster member a DM channel belongs to, or undefined when the channel is
 * not a bot's DM.
 *
 * Resolved by BUILDING each member's canonical slug and comparing, never by
 * splitting the channel on "__": lib/channels.ts owns the pair-sort, and a
 * second reading of it here is exactly the kind of copy that drifts.
 */
export function dmBotForChannel(
  channel: string,
  members: readonly OfficeMember[],
): OfficeMember | undefined {
  const target = channel.trim().toLowerCase();
  if (!target) return undefined;
  return members.find((m) => m.slug && directChannelSlug(m.slug) === target);
}
