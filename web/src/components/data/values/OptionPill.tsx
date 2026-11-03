import type { SelectOption } from "../../../api/dataspaces";

import "../../../styles/data-values.css";

export type OptionPillVariant = "select" | "status";

export interface OptionPillProps {
  option: SelectOption;
  /** `status` adds a leading dot so state reads even without the color. */
  variant?: OptionPillVariant;
}

/**
 * A select or status option. Color carries meaning here and nowhere else in
 * the value layer: `option.color` is a semantic slot that the stylesheet
 * resolves to a theme token pair, so the pill retints with the theme.
 */
export function OptionPill({ option, variant = "select" }: OptionPillProps) {
  return (
    <span
      className={`dv-pill dv-pill--${option.color}`}
      data-variant={variant}
      title={option.name}
    >
      {variant === "status" ? (
        <span className="dv-pill__dot" aria-hidden="true" />
      ) : null}
      <span className="dv-pill__label">{option.name}</span>
    </span>
  );
}
