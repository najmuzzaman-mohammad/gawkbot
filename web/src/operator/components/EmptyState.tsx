// Empty state — warmth + context + a primary action, never a dead-end line.
// Presentational; the action is optional.

import { PixelAvatar } from "../../components/ui/PixelAvatar";

interface EmptyStateProps {
  glyph: string;
  title: string;
  hint: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Draw an agent portrait instead of the glyph. An empty surface that belongs
   *  to somebody reads better with their face on it than with a symbol. */
  portraitSlug?: string;
}

export function EmptyState({
  glyph,
  title,
  hint,
  actionLabel,
  onAction,
  portraitSlug,
}: EmptyStateProps) {
  return (
    <div className="opr-empty">
      <span
        className={`opr-empty-glyph${portraitSlug ? " opr-portrait-frame" : ""}`}
        aria-hidden={true}
      >
        {portraitSlug ? <PixelAvatar slug={portraitSlug} size={30} /> : glyph}
      </span>
      <div className="opr-empty-title">{title}</div>
      <div className="opr-empty-hint">{hint}</div>
      {actionLabel && onAction ? (
        <div className="opr-empty-actions">
          <button
            type="button"
            className="opr-btn opr-btn-primary opr-btn-sm"
            onClick={onAction}
          >
            {actionLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
