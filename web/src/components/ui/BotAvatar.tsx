import { type BotRuntime, useBotRuntime } from "../../lib/botRuntime";
import { ModelBadge } from "./ModelBadge";
import { OrbAvatar, type OrbAvatarProps } from "./OrbAvatar";

export interface BotAvatarProps extends OrbAvatarProps {
  /**
   * The model badge is on by default, everywhere. Turn it off only where the
   * mark is not a running bot: a look being chosen in the picker, the brand
   * mark, an illustration.
   */
  badge?: boolean;
  /**
   * The bot's runtime, for a caller that already holds it. Otherwise it is
   * looked up by slug from the nearest BotRuntimeContext.
   */
  runtime?: BotRuntime;
}

/**
 * A bot's face with what it runs on. Every bot avatar in the app and the
 * notch renders through this, so the model badge cannot be forgotten at a
 * call site: OrbAvatar draws the face, this adds the badge.
 *
 * A slug with no known runtime (a human, a bot the roster has not loaded
 * yet) gets the bare face and no wrapper, so its layout is unchanged.
 */
export function BotAvatar({ badge = true, runtime, ...orb }: BotAvatarProps) {
  const found = useBotRuntime(orb.slug);
  const resolved = badge ? (runtime ?? found) : undefined;
  if (!resolved) return <OrbAvatar {...orb} />;
  return (
    <span className="bot-avatar" data-bot-avatar={orb.slug}>
      <OrbAvatar {...orb} />
      <ModelBadge runtime={resolved} avatarSize={orb.size} />
    </span>
  );
}
