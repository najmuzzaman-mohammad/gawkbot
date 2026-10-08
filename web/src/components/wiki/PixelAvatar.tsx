import { useMemberAvatar } from "../../hooks/useMembers";
import type { AvatarChoice } from "../../lib/blobAvatar";
import { PixelAvatar as CanvasPixelAvatar } from "../ui/PixelAvatar";

/**
 * Wiki-surface bot avatar — default-export wrapper over the shared
 * `components/ui/PixelAvatar`, so it draws whatever that draws (the smooth
 * vector mark in blob mode, the canvas sprite in sprite mode). Keeps the
 * wiki's byline, backlinks, edit-log entries, Sources list, and catalog cards
 * visually in sync with bot avatars rendered elsewhere in the app.
 */

interface PixelAvatarProps {
  slug: string;
  size?: number;
  className?: string;
  title?: string;
  /**
   * The bot's chosen look, when the caller has the member at hand. Omitted,
   * it is read from the office roster by slug: wiki bylines, edit logs and
   * audit rows only carry the author's slug.
   */
  avatar?: AvatarChoice | null;
}

export default function PixelAvatar({
  slug,
  size = 14,
  className = "wk-avatar",
  title,
  avatar,
}: PixelAvatarProps) {
  const rosterAvatar = useMemberAvatar(slug);
  // The underlying component is aria-hidden; the wiki uses avatars purely
  // decorative next to bot slug labels, so no extra role/title is needed.
  // `title` is accepted for API compatibility with the legacy stub and set
  // via a wrapping span when provided.
  const mark = (
    <CanvasPixelAvatar
      slug={slug}
      size={size}
      className={className}
      avatar={avatar ?? rosterAvatar}
    />
  );
  if (title) {
    return (
      <span className="wk-avatar-wrap" title={title}>
        {mark}
      </span>
    );
  }
  return mark;
}
