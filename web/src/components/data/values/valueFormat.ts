/**
 * Pure value helpers for the Data section: display text, emptiness, and the
 * string-draft contract every editor in `ValueField` speaks.
 *
 * Drafts are always strings so one lifecycle hook can compare, restore, and
 * commit any attribute type. `draftToValue` does SHAPE conversion only; it
 * never rejects. A draft that cannot take the attribute's shape (for example
 * "12abc" on a number) is passed through as the raw string so the client can
 * reject it with a message, instead of this layer silently clearing the value.
 */

import {
  ATTRIBUTE_TYPES,
  type AttributeDefinition,
  type AttributeType,
  type AttributeValue,
  type SelectOption,
} from "../../../api/dataspaces";

const DISPLAY_LOCALE = "en-US";
const DEFAULT_CURRENCY_CODE = "USD";
const MULTIVALUE_DRAFT_SEPARATOR = ",";
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const MAX_NUMBER_FRACTION_DIGITS = 6;

export const RATING_MAX = 5;
export const TOGGLE_DRAFT_TRUE = "true";
export const TOGGLE_DRAFT_FALSE = "false";

const ATTRIBUTE_TYPE_LABELS: Readonly<Record<AttributeType, string>> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  date: "Date",
  toggle: "Checkbox",
  select: "Select",
  status: "Status",
  rating: "Rating",
  url: "URL",
  email: "Email",
  phone: "Phone",
  relationship: "Relation",
};

const KNOWN_ATTRIBUTE_TYPES: ReadonlySet<string> = new Set(ATTRIBUTE_TYPES);

/** False for a type the server knows and this bundle does not. */
export function isKnownAttributeType(type: string): boolean {
  return KNOWN_ATTRIBUTE_TYPES.has(type);
}

/** An unknown type labels itself, so the operator can see what it is. */
export function attributeTypeLabel(type: AttributeType): string {
  const labels: Readonly<Record<string, string | undefined>> =
    ATTRIBUTE_TYPE_LABELS;
  return labels[type] ?? type;
}

/**
 * Relationship links are edited by a separate picker, never inline here, and
 * a type this bundle does not know has no editor at all: offering one would
 * hand the store a value shaped by a guess.
 */
export function isInlineEditable(attribute: AttributeDefinition): boolean {
  return (
    attribute.type !== "relationship" && isKnownAttributeType(attribute.type)
  );
}

export function optionById(
  attribute: AttributeDefinition,
  id: string,
): SelectOption | undefined {
  return attribute.options.find((option) => option.id === id);
}

/** `false` and `0` are real values; only absence and blank text are empty. */
export function isEmptyValue(
  value: AttributeValue | null | undefined,
): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return Number.isNaN(value);
  if (typeof value === "boolean") return false;
  return value.length === 0;
}

function isStringArray(value: AttributeValue): value is readonly string[] {
  return Array.isArray(value);
}

/** Option ids carried by a select or status value, in stored order. */
export function selectedOptionIds(
  value: AttributeValue | null | undefined,
): readonly string[] {
  if (value === undefined || value === null) return [];
  if (isStringArray(value)) return value.filter((id) => id !== "");
  if (typeof value === "string" && value !== "") return [value];
  return [];
}

/** Resolved options for a select or status value; unknown ids are dropped. */
export function selectedOptions(
  attribute: AttributeDefinition,
  value: AttributeValue | null | undefined,
): readonly SelectOption[] {
  return selectedOptionIds(value).flatMap((id) => {
    const option = optionById(attribute, id);
    return option ? [option] : [];
  });
}

export function parseDraftOptionIds(draft: string): readonly string[] {
  return draft
    .split(MULTIVALUE_DRAFT_SEPARATOR)
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

export function joinDraftOptionIds(ids: readonly string[]): string {
  return ids.join(MULTIVALUE_DRAFT_SEPARATOR);
}

function toFiniteNumber(value: AttributeValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(DISPLAY_LOCALE, {
    maximumFractionDigits: MAX_NUMBER_FRACTION_DIGITS,
  }).format(value);
}

function formatCurrency(value: number, currencyCode: string | null): string {
  const code = currencyCode?.trim() || DEFAULT_CURRENCY_CODE;
  const wholeDigits = Number.isInteger(value)
    ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
    : {};
  try {
    return new Intl.NumberFormat(DISPLAY_LOCALE, {
      style: "currency",
      currency: code,
      ...wholeDigits,
    }).format(value);
  } catch (error: unknown) {
    // Intl throws RangeError on a code that is not well-formed ISO 4217.
    // Bots mint these, so degrade to a readable label instead of crashing
    // the whole table over one bad attribute definition.
    if (error instanceof RangeError) return `${code} ${formatNumber(value)}`;
    throw error;
  }
}

/**
 * "2026-09-17" -> "Sep 17, 2026". The parts are read straight off the string
 * and formatted in UTC, so the calendar day never shifts with the viewer's
 * timezone the way `new Date("2026-09-17")` rendered locally would.
 */
function formatDate(raw: string): string {
  const match = ISO_DATE_PATTERN.exec(raw.trim());
  if (!match) return raw;
  const [, year, month, day] = match;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(utc.getTime())) return raw;
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(utc);
}

function formatNumeric(
  value: AttributeValue,
  format: (parsed: number) => string,
): string {
  const parsed = toFiniteNumber(value);
  return parsed === null ? String(value) : format(parsed);
}

/** Plain display text for any attribute type. Empty values render as "". */
export function formatValue(
  attribute: AttributeDefinition,
  value: AttributeValue | undefined,
): string {
  if (value === undefined || isEmptyValue(value)) return "";
  switch (attribute.type) {
    case "number":
      return formatNumeric(value, formatNumber);
    case "currency":
      return formatNumeric(value, (parsed) =>
        formatCurrency(parsed, attribute.currencyCode),
      );
    case "rating":
      return formatNumeric(value, (parsed) => `${parsed}/${RATING_MAX}`);
    case "date":
      return formatDate(String(value));
    case "toggle":
      return value === true || value === TOGGLE_DRAFT_TRUE ? "Yes" : "No";
    case "select":
    case "status":
      return selectedOptions(attribute, value)
        .map((option) => option.name)
        .join(", ");
    case "relationship":
      return "";
    default:
      return String(value);
  }
}

/** The editor's starting string for a stored value. */
export function valueToDraft(
  attribute: AttributeDefinition,
  value: AttributeValue | undefined,
): string {
  if (value === undefined || isEmptyValue(value)) return "";
  switch (attribute.type) {
    case "toggle":
      return value === true || value === TOGGLE_DRAFT_TRUE
        ? TOGGLE_DRAFT_TRUE
        : TOGGLE_DRAFT_FALSE;
    case "select":
    case "status":
      return joinDraftOptionIds(selectedOptionIds(value));
    case "date": {
      const match = ISO_DATE_PATTERN.exec(String(value).trim());
      return match ? match[0] : String(value);
    }
    case "relationship":
      return "";
    default:
      return String(value);
  }
}

function draftToNumber(trimmed: string): AttributeValue {
  const parsed = Number(trimmed.replace(/,/g, ""));
  // Not a number: hand the raw text to the client so it can say why.
  return Number.isFinite(parsed) ? parsed : trimmed;
}

/** Shape conversion only. `null` means "clear this value". */
export function draftToValue(
  attribute: AttributeDefinition,
  draft: string,
): AttributeValue | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  switch (attribute.type) {
    case "number":
    case "currency":
    case "rating":
      return draftToNumber(trimmed);
    case "toggle":
      return trimmed === TOGGLE_DRAFT_TRUE;
    case "select":
    case "status": {
      const ids = parseDraftOptionIds(trimmed);
      if (ids.length === 0) return null;
      return attribute.isMultivalue ? ids : ids[0];
    }
    case "relationship":
      return null;
    default:
      return trimmed;
  }
}

/**
 * `https://` is assumed when a stored URL carries no protocol. Values are
 * written by bots and by apps, so only http and https ever become an href;
 * any other scheme (`javascript:`, `data:`, ...) returns "" and the caller
 * renders plain text instead of a link.
 */
export function normalizeUrlHref(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^/:]+:\d/.test(trimmed)) {
    return "";
  }
  return `https://${trimmed}`;
}

/** Display form of a URL: no protocol, no trailing slash. */
export function displayUrl(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

/** `tel:` keeps digits and a leading plus; formatting characters are noise. */
export function phoneHref(raw: string): string {
  return `tel:${raw.trim().replace(/[^\d+]/g, "")}`;
}
