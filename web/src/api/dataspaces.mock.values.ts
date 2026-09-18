/**
 * Value coercion and validation for the in-memory data client. The Go store
 * (slice S2) is written to match these rules, so every branch is covered by
 * `dataspaces.mock.test.ts`.
 */

import type {
  AttributeDefinition,
  AttributeValue,
  ObjectType,
} from "./dataspaces";
import {
  fail,
  primaryAttribute,
  type SpaceState,
  type StoredRecord,
} from "./dataspaces.mock.store";

export const MAX_OPTIONS_IN_ERROR = 25;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339 =
  /^(\d{4}-\d{2}-\d{2})[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function show(raw: unknown): string {
  return typeof raw === "string" ? `"${raw}"` : JSON.stringify(raw);
}

function isRealDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function coerceNumber(attribute: AttributeDefinition, raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fail(
    `${attribute.name} must be a number; got ${show(raw)}.`,
    attribute.slug,
  );
}

function coerceRating(attribute: AttributeDefinition, raw: unknown): number {
  const value = coerceNumber(attribute, raw);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    fail(
      `${attribute.name} must be a whole number from 1 to 5; got ${show(raw)}.`,
      attribute.slug,
    );
  }
  return value;
}

function coerceDate(attribute: AttributeDefinition, raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // The calendar date is kept exactly as written; no time zone shift.
    const datePart = RFC3339.exec(trimmed)?.[1] ?? trimmed;
    if (isRealDate(datePart)) return datePart;
  }
  return fail(
    `${attribute.name} must be a date as YYYY-MM-DD or RFC3339; got ${show(raw)}.`,
    attribute.slug,
  );
}

function coerceToggle(attribute: AttributeDefinition, raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const word = raw.trim().toLowerCase();
    if (word === "true") return true;
    if (word === "false") return false;
  }
  return fail(
    `${attribute.name} must be true or false; got ${show(raw)}.`,
    attribute.slug,
  );
}

function coerceString(attribute: AttributeDefinition, raw: unknown): string {
  if (typeof raw !== "string") {
    return fail(
      `${attribute.name} must be text; got ${show(raw)}.`,
      attribute.slug,
    );
  }
  return attribute.type === "text" ? raw : raw.trim();
}

function coerceEmail(attribute: AttributeDefinition, raw: unknown): string {
  const value = coerceString(attribute, raw);
  if (!EMAIL.test(value)) {
    fail(
      `${attribute.name} must be an email address like name@company.com; got ${show(raw)}.`,
      attribute.slug,
    );
  }
  return value;
}

function coerceUrl(attribute: AttributeDefinition, raw: unknown): string {
  const value = coerceString(attribute, raw);
  let protocol = "";
  try {
    ({ protocol } = new URL(value));
  } catch {
    // Not parseable as a URL at all; reported below with the same message.
    protocol = "";
  }
  if (protocol !== "http:" && protocol !== "https:") {
    fail(
      `${attribute.name} must be a full URL starting with http:// or https://; got ${show(raw)}.`,
      attribute.slug,
    );
  }
  return value;
}

/** Matches by option id first, then by case-insensitive trimmed name. */
function coerceOption(attribute: AttributeDefinition, raw: unknown): string {
  const wanted = typeof raw === "string" ? raw.trim() : String(raw);
  const byId = attribute.options.find((option) => option.id === wanted);
  if (byId) return byId.id;
  const byName = attribute.options.find(
    (option) => option.name.trim().toLowerCase() === wanted.toLowerCase(),
  );
  if (byName) return byName.id;
  const names = attribute.options.map((option) => option.name);
  const shown = names.slice(0, MAX_OPTIONS_IN_ERROR).join(", ");
  const hidden = names.length - MAX_OPTIONS_IN_ERROR;
  const more = hidden > 0 ? `, and ${hidden} more` : "";
  return fail(
    `"${wanted}" is not a valid option for ${attribute.name}. Valid options: ${shown}${more}.`,
    attribute.slug,
  );
}

function coerceScalar(
  attribute: AttributeDefinition,
  raw: unknown,
): string | number | boolean {
  switch (attribute.type) {
    case "number":
    case "currency":
      return coerceNumber(attribute, raw);
    case "rating":
      return coerceRating(attribute, raw);
    case "date":
      return coerceDate(attribute, raw);
    case "toggle":
      return coerceToggle(attribute, raw);
    case "email":
      return coerceEmail(attribute, raw);
    case "url":
      return coerceUrl(attribute, raw);
    case "select":
    case "status":
      return coerceOption(attribute, raw);
    case "relationship":
      return fail(
        `"${attribute.slug}" is a relationship, so it is set by linking records, not by setting a value.`,
        attribute.slug,
      );
    default:
      return coerceString(attribute, raw);
  }
}

function isBlank(raw: unknown): boolean {
  return (
    raw === null ||
    raw === undefined ||
    (typeof raw === "string" && raw.trim() === "")
  );
}

/** A list or a bare scalar in; a de-duplicated list, or `null`, out. */
function coerceMany(
  attribute: AttributeDefinition,
  raw: unknown,
): readonly string[] | null {
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  const byKey = new Map<string, string>();
  for (const item of items.filter((entry) => !isBlank(entry))) {
    const value = String(coerceScalar(attribute, item));
    const key = attribute.type === "email" ? value.toLowerCase() : value;
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return byKey.size > 0 ? [...byKey.values()] : null;
}

/** Returns `null` when the input means "empty". */
export function coerceValue(
  attribute: AttributeDefinition,
  raw: unknown,
): AttributeValue | null {
  if (attribute.isMultivalue) return coerceMany(attribute, raw);
  if (Array.isArray(raw)) {
    return fail(
      `${attribute.name} holds a single value, not a list.`,
      attribute.slug,
    );
  }
  if (isBlank(raw)) return null;
  return coerceScalar(attribute, raw);
}

function uniqueKey(value: AttributeValue): string {
  return String(value).trim().toLowerCase();
}

function assertUnique(
  state: SpaceState,
  type: ObjectType,
  attribute: AttributeDefinition,
  value: AttributeValue,
  selfId: string | null,
) {
  const primarySlug = primaryAttribute(type).slug;
  const clash = state.records.find((record) => {
    if (record.typeId !== type.id || record.id === selfId) return false;
    const other = record.values[attribute.slug];
    return other !== undefined && uniqueKey(other) === uniqueKey(value);
  });
  if (clash) {
    const label = String(clash.values[primarySlug] ?? "");
    fail(
      `${attribute.name} ${show(value)} is already used by record ${clash.id} (${label}). ${attribute.name} must be unique; update that record instead.`,
      attribute.slug,
    );
  }
}

/** Resolves a slug in a values patch, or explains what to use instead. */
function valueAttribute(type: ObjectType, slug: string): AttributeDefinition {
  const attribute = type.attributes.find((item) => item.slug === slug);
  if (!attribute) {
    const valid = type.attributes
      .filter((item) => item.type !== "relationship")
      .map((item) => item.slug);
    return fail(
      `"${slug}" is not an attribute of ${type.name}. Valid attributes: ${valid.join(", ")}.`,
      slug,
    );
  }
  if (attribute.type === "relationship") {
    return fail(
      `"${slug}" is a relationship, so it is set by linking records, not by setting a value.`,
      slug,
    );
  }
  return attribute;
}

/**
 * Applies a values patch on top of `existing` (or nothing, on create) and
 * returns the full next values map. Throws before anything is written.
 */
export function applyValuesPatch(
  state: SpaceState,
  type: ObjectType,
  patch: Readonly<Record<string, unknown>>,
  existing: StoredRecord | null,
): Readonly<Record<string, AttributeValue>> {
  const entries = Object.entries(patch).filter(([, raw]) => raw !== undefined);
  const coerced = new Map<string, AttributeValue | null>();
  for (const [slug, raw] of entries) {
    const attribute = valueAttribute(type, slug);
    const value = coerceValue(attribute, raw);
    if (value === null && attribute.isRequired && existing !== null) {
      fail(`${attribute.name} is required and cannot be cleared.`, slug);
    }
    if (value !== null && attribute.isUnique) {
      assertUnique(state, type, attribute, value, existing?.id ?? null);
    }
    coerced.set(slug, value);
  }

  const kept = Object.entries(existing?.values ?? {}).filter(
    ([slug]) => !coerced.has(slug),
  );
  const set = [...coerced].filter(
    (entry): entry is [string, AttributeValue] => entry[1] !== null,
  );
  const next: Record<string, AttributeValue> = Object.fromEntries([
    ...kept,
    ...set,
  ]);

  const missing =
    existing === null
      ? type.attributes.find(
          (attribute) =>
            attribute.isRequired && next[attribute.slug] === undefined,
        )
      : undefined;
  if (missing) fail(`${missing.name} is required.`, missing.slug);
  return next;
}
