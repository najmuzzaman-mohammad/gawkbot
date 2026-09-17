import type { ComponentType, MouseEvent, ReactNode } from "react";
import { Check } from "iconoir-react";

import type {
  AttributeDefinition,
  AttributeType,
  AttributeValue,
} from "../../../api/dataspaces";
import { OptionPill, type OptionPillVariant } from "./OptionPill";
import {
  displayUrl,
  formatValue,
  isEmptyValue,
  normalizeUrlHref,
  phoneHref,
  RATING_MAX,
  selectedOptions,
} from "./valueFormat";

import "../../../styles/data-values.css";

export interface ValueCellProps {
  attribute: AttributeDefinition;
  value: AttributeValue | undefined;
}

export type DisplayableAttributeType = Exclude<AttributeType, "relationship">;

/** A middle dot, muted. Never a dash: a dash reads as a value in a data grid. */
const EMPTY_PLACEHOLDER = "·";

function EmptyValue() {
  return (
    <span className="dv-empty" aria-hidden="true">
      {EMPTY_PLACEHOLDER}
    </span>
  );
}

function TextValueCell({ attribute, value }: ValueCellProps) {
  const text = formatValue(attribute, value);
  if (text === "") return <EmptyValue />;
  return (
    <span className="dv-text" title={text}>
      {text}
    </span>
  );
}

function NumericValueCell({ attribute, value }: ValueCellProps) {
  const text = formatValue(attribute, value);
  if (text === "") return <EmptyValue />;
  return (
    <span className="dv-numeric" title={text}>
      {text}
    </span>
  );
}

function DateValueCell({ attribute, value }: ValueCellProps) {
  const text = formatValue(attribute, value);
  if (text === "") return <EmptyValue />;
  return (
    <time
      className="dv-date"
      dateTime={typeof value === "string" ? value : undefined}
    >
      {text}
    </time>
  );
}

export interface ToggleGlyphProps {
  isChecked: boolean;
}

/** The checkbox mark on its own, so the editable cell can reuse it. */
export function ToggleGlyph({ isChecked }: ToggleGlyphProps) {
  return (
    <span
      className="dv-toggle"
      data-checked={isChecked ? "true" : "false"}
      role="img"
      aria-label={isChecked ? "Yes" : "No"}
    >
      {isChecked ? (
        <Check
          className="dv-toggle__mark"
          aria-hidden="true"
          focusable="false"
        />
      ) : null}
    </span>
  );
}

function ToggleValueCell({ value }: ValueCellProps) {
  return <ToggleGlyph isChecked={value === true} />;
}

function optionValueCell(variant: OptionPillVariant) {
  return function OptionValueCell({ attribute, value }: ValueCellProps) {
    const options = selectedOptions(attribute, value);
    if (options.length === 0) return <EmptyValue />;
    return (
      <span className="dv-pills">
        {options.map((option) => (
          <OptionPill key={option.id} option={option} variant={variant} />
        ))}
      </span>
    );
  };
}

const RATING_STEPS: readonly number[] = Array.from(
  { length: RATING_MAX },
  (_, index) => index + 1,
);

export interface RatingMarksProps {
  rating: number;
}

/** Five marks, the first `rating` of them filled. Decorative on its own. */
export function RatingMarks({ rating }: RatingMarksProps) {
  return (
    <span className="dv-rating__marks" aria-hidden="true">
      {RATING_STEPS.map((step) => (
        <span
          key={step}
          className="dv-rating__mark"
          data-filled={step <= rating ? "true" : "false"}
        />
      ))}
    </span>
  );
}

function RatingValueCell({ value }: ValueCellProps) {
  if (typeof value !== "number" || isEmptyValue(value)) return <EmptyValue />;
  const rating = Math.max(0, Math.min(RATING_MAX, Math.round(value)));
  return (
    <span
      className="dv-rating"
      role="img"
      aria-label={`${rating} out of ${RATING_MAX}`}
    >
      <RatingMarks rating={rating} />
    </span>
  );
}

/**
 * Cells sit inside rows and focusable gridcells that have their own click and
 * double-click behavior. Following a link must not also trigger those.
 */
function stopClickPropagation(event: MouseEvent<HTMLAnchorElement>) {
  event.stopPropagation();
}

interface LinkValueProps {
  href: string;
  label: string;
  isExternal?: boolean;
}

function LinkValue({ href, label, isExternal = false }: LinkValueProps) {
  if (href === "") {
    return (
      <span className="dv-text" title={label}>
        {label}
      </span>
    );
  }
  return (
    <a
      className="dv-link"
      href={href}
      title={label}
      onClick={stopClickPropagation}
      {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {label}
    </a>
  );
}

function linkText(value: AttributeValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function UrlValueCell({ value }: ValueCellProps) {
  const raw = linkText(value);
  if (raw === "") return <EmptyValue />;
  return (
    <LinkValue
      href={normalizeUrlHref(raw)}
      label={displayUrl(raw)}
      isExternal={true}
    />
  );
}

function EmailValueCell({ value }: ValueCellProps) {
  const raw = linkText(value);
  if (raw === "") return <EmptyValue />;
  return <LinkValue href={`mailto:${raw}`} label={raw} />;
}

function PhoneValueCell({ value }: ValueCellProps) {
  const raw = linkText(value);
  if (raw === "") return <EmptyValue />;
  return <LinkValue href={phoneHref(raw)} label={raw} />;
}

/** One display renderer per attribute type. Relationships render elsewhere. */
export const VALUE_CELL_RENDERERS: Record<
  DisplayableAttributeType,
  ComponentType<ValueCellProps>
> = {
  text: TextValueCell,
  number: NumericValueCell,
  currency: NumericValueCell,
  date: DateValueCell,
  toggle: ToggleValueCell,
  select: optionValueCell("select"),
  status: optionValueCell("status"),
  rating: RatingValueCell,
  url: UrlValueCell,
  email: EmailValueCell,
  phone: PhoneValueCell,
};

/** Read-only display of one attribute value. */
export function ValueCell({ attribute, value }: ValueCellProps): ReactNode {
  if (attribute.type === "relationship") return null;
  // Rendered as an element, never called: renderers may hold hooks, and a
  // direct call would run them on this component's fiber.
  const Renderer = VALUE_CELL_RENDERERS[attribute.type];
  return <Renderer attribute={attribute} value={value} />;
}
