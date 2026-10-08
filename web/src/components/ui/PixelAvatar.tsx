import type { AvatarChoice } from "../../lib/blobAvatar";
import { BlobAvatar } from "./BlobAvatar";

interface PixelAvatarProps {
  slug: string;
  size: number;
  className?: string;
  /**
   * True only for the bot that is PROCESSING RIGHT NOW, not merely online.
   * This is the only thing that animates: an idle avatar paints once and then
   * does nothing, so a sidebar of a dozen teammates is a dozen static marks.
   */
  working?: boolean;
  /**
   * The bot's chosen look (OfficeMember.avatar). Unset fields fall back to
   * the slug-derived species and colour.
   */
  avatar?: AvatarChoice | null;
}

/**
 * A bot's portrait, everywhere in the app. The name is historical: it was a
 * pixel sprite once, then a flat blob; it is now the character in
 * components/ui/BlobAvatar.tsx. Call sites style it through the
 * `pixel-avatar` class and size variants (`pixel-avatar-sidebar`,
 * `pixel-avatar-panel`), so the name stays.
 *
 * A working bot concentrates: narrowed eyes, gawking on a CSS loop.
 */
export function PixelAvatar({
  slug,
  size,
  className,
  working = false,
  avatar,
}: PixelAvatarProps) {
  return (
    <BlobAvatar
      slug={slug}
      size={size}
      avatar={avatar}
      working={working}
      expression={working ? "focus" : "calm"}
      className={["pixel-avatar", "pixel-avatar--smooth", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
