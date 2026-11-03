/**
 * Naming helpers for the schema dialogs. Pure, so the dialogs stay thin and
 * the rules are testable on their own.
 */

const ES_ENDINGS = ["s", "x", "z", "ch", "sh"] as const;
const VOWELS = "aeiou";
const SLUG_FALLBACK = "object";

/**
 * Small English pluralizer for object type names. It covers the common
 * shapes only (y to ies, sibilants to es, otherwise s); the operator can
 * always type the plural by hand.
 */
export function pluralize(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "";
  const lower = trimmed.toLowerCase();
  const last = lower.charAt(lower.length - 1);
  const beforeLast = lower.charAt(lower.length - 2);
  if (last === "y" && beforeLast !== "" && !VOWELS.includes(beforeLast)) {
    return `${trimmed.slice(0, -1)}ies`;
  }
  if (ES_ENDINGS.some((ending) => lower.endsWith(ending))) {
    return `${trimmed}es`;
  }
  return `${trimmed}s`;
}

/**
 * Preview of the slug the store will mint for a new object type: lowercase,
 * runs of anything else collapse to one underscore, and a numeric suffix
 * avoids a slug that is already taken. The store stays the source of truth;
 * this only tells the operator what to expect.
 */
export function slugPreview(
  name: string,
  takenSlugs: readonly string[] = [],
): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = cleaned === "" ? SLUG_FALLBACK : cleaned;
  if (!takenSlugs.includes(base)) return base;
  let suffix = 2;
  while (takenSlugs.includes(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}
