import {
  type BotRuntime,
  badgeDensity,
  badgeText,
  runtimeTitle,
} from "../../lib/botRuntime";
import "../../styles/model-badge.css";

interface ModelBadgeProps {
  runtime: BotRuntime;
  /** Size of the avatar the badge sits on; it decides how much is spelled out. */
  avatarSize: number;
  className?: string;
}

/**
 * What a bot runs on, as a small tag on its avatar: "Opus 5.5" where there is
 * room, "Opus" or "Op" where there is less, a dot where there is none. The
 * full answer ("Opus 5.5 in Claude Code") is always the tooltip and the
 * accessible name.
 */
export function ModelBadge({
  runtime,
  avatarSize,
  className,
}: ModelBadgeProps) {
  const density = badgeDensity(avatarSize);
  const title = runtimeTitle(runtime);
  return (
    <span
      className={["model-badge", `model-badge--${density}`, className]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={`Runs on ${title}`}
      title={title}
      data-family={runtime.family || undefined}
      data-source={runtime.source || undefined}
    >
      {badgeText(runtime, density)}
    </span>
  );
}
