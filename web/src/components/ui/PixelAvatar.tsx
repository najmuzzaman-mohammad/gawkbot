import type { AvatarChoice } from "../../lib/blobAvatar";
import { OrbAvatar } from "./OrbAvatar";

interface PixelAvatarProps {
  slug: string;
  size: number;
  className?: string;
  /**
   * True only for the bot that is PROCESSING RIGHT NOW, not merely online.
   * This is the only thing that animates: an idle avatar is posed once and
   * then does nothing, so a sidebar of a dozen teammates is a dozen still
   * marks.
   */
  working?: boolean;
  /**
   * The bot's chosen look (OfficeMember.avatar). Unset fields fall back to
   * the slug-derived body and colour.
   */
  avatar?: AvatarChoice | null;
}

/**
 * A bot's portrait, everywhere in the app. The name is historical: it was a
 * pixel sprite once, then a flat blob; it is now the orb in
 * components/ui/OrbAvatar.tsx. Call sites style it through the
 * `pixel-avatar` class and size variants (`pixel-avatar-sidebar`,
 * `pixel-avatar-panel`), so the name stays.
 *
 * A working bot concentrates: its eyes spin, live, until it is done.
 */
export function PixelAvatar({
  slug,
  size,
  className,
  working = false,
  avatar,
}: PixelAvatarProps) {
  return (
    <OrbAvatar
      slug={slug}
      size={size}
      avatar={avatar}
      face={working ? "working" : "calm"}
      live={working}
      className={["pixel-avatar", "pixel-avatar--smooth", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
