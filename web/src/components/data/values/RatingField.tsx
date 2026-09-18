import { type KeyboardEvent, useEffect, useId, useRef } from "react";

import type { ValueFieldProps } from "./valueFieldTypes";
import { RATING_MAX } from "./valueFormat";

const RATING_STEPS: readonly number[] = Array.from(
  { length: RATING_MAX },
  (_, index) => index + 1,
);

const CLEAR_KEYS: ReadonlySet<string> = new Set(["0", "Backspace", "Delete"]);
const INCREASE_KEYS: ReadonlySet<string> = new Set(["ArrowRight", "ArrowUp"]);
const DECREASE_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowDown"]);

function parseRating(draft: string): number {
  const parsed = Number(draft.trim());
  if (!Number.isInteger(parsed)) return 0;
  return Math.max(0, Math.min(RATING_MAX, parsed));
}

function nextRatingForKey(key: string, rating: number): number | null {
  if (INCREASE_KEYS.has(key)) return Math.min(RATING_MAX, rating + 1);
  if (DECREASE_KEYS.has(key)) return Math.max(1, rating - 1);
  if (CLEAR_KEYS.has(key)) return 0;
  if (/^[1-5]$/.test(key)) return Number(key);
  return null;
}

/**
 * Five native radios drawn as marks. Arrow keys move and select, handled
 * here rather than left to the browser so the group also works from "nothing
 * selected" and never wraps from 5 back to 1. Digits 1 to 5 jump; 0,
 * Backspace, or Delete clears; and clicking the current rating clears it,
 * which a native radio cannot do on its own.
 */
export function RatingField({
  attribute,
  draft,
  onDraftChange,
  autoFocus,
  disabled,
  id,
}: ValueFieldProps) {
  const rating = parseRating(draft);
  const groupName = useId();
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  // Captured once: focus-on-mount targets the rating the editor opened with.
  // Later changes move focus through `select` below.
  const initialFocusIndexRef = useRef(rating === 0 ? 0 : rating - 1);

  useEffect(() => {
    if (!autoFocus) return;
    inputRefs.current[initialFocusIndexRef.current]?.focus();
  }, [autoFocus]);

  const select = (next: number) => {
    if (disabled) return;
    onDraftChange(next === 0 ? "" : String(next));
    inputRefs.current[next === 0 ? 0 : next - 1]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextRatingForKey(event.key, rating);
    if (next === null) return;
    event.preventDefault();
    select(next);
  };

  return (
    <div
      id={id}
      className="dv-rating-field"
      role="radiogroup"
      aria-label={attribute.name}
      onKeyDown={handleKeyDown}
    >
      {RATING_STEPS.map((step) => (
        <label
          key={step}
          className="dv-rating-field__step"
          data-filled={step <= rating ? "true" : "false"}
        >
          <input
            ref={(node) => {
              inputRefs.current[step - 1] = node;
            }}
            className="dv-rating-field__input"
            type="radio"
            name={groupName}
            value={step}
            aria-label={`${step} out of ${RATING_MAX}`}
            checked={step === rating}
            disabled={disabled}
            onChange={() => select(step)}
            onClick={() => {
              // A checked radio fires click but never change.
              if (step === rating) select(0);
            }}
          />
          <span className="dv-rating__mark" aria-hidden="true" />
        </label>
      ))}
    </div>
  );
}
