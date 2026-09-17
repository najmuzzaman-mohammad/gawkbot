import { PixelAvatar } from "../ui/PixelAvatar";

/** `createdBy` value the store records for the human operator. */
export const HUMAN_ACTOR = "human";

interface BotBylineProps {
  /** Bot slug, or `HUMAN_ACTOR`. */
  actor: string;
  /** Leading verb, e.g. "Created by" or "Owned by". */
  verb?: string;
}

/**
 * Provenance line. Bots build most of this data, so every space, object type,
 * and record says who made it.
 */
export function BotByline({ actor, verb = "Created by" }: BotBylineProps) {
  if (actor === HUMAN_ACTOR) {
    return <span className="data-byline">{verb} you</span>;
  }
  return (
    <span className="data-byline">
      {verb}
      <PixelAvatar slug={actor} size={14} />
      <span className="data-byline-slug">@{actor}</span>
    </span>
  );
}
