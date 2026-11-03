import type {
  AttributeDefinition,
  DataRecord,
  ObjectType,
} from "../../../api/dataspaces";

export const UNTITLED_RECORD = "Untitled";
const TO_ONE_CARDINALITIES: readonly string[] = ["many_to_one", "one_to_one"];
const TARGET_TO_ONE_CARDINALITIES: readonly string[] = [
  "one_to_many",
  "one_to_one",
];

export function primaryAttributeOf(
  type: ObjectType,
): AttributeDefinition | undefined {
  return type.attributes.find((attribute) => attribute.isPrimary);
}

/** The record's display name: its primary attribute, never an id. */
export function recordName(record: DataRecord, type: ObjectType): string {
  const primary = primaryAttributeOf(type);
  const raw = primary ? record.values[primary.slug] : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  return text === "" ? UNTITLED_RECORD : text;
}

/** This side of the relationship holds at most one linked record. */
export function holdsOne(attribute: AttributeDefinition): boolean {
  const cardinality = attribute.relationship?.cardinality;
  return (
    cardinality !== undefined && TO_ONE_CARDINALITIES.includes(cardinality)
  );
}

/** Each target record can be linked from at most one record of this type. */
export function targetHoldsOne(attribute: AttributeDefinition): boolean {
  const cardinality = attribute.relationship?.cardinality;
  return (
    cardinality !== undefined &&
    TARGET_TO_ONE_CARDINALITIES.includes(cardinality)
  );
}

export function relationshipAttributes(
  type: ObjectType,
): readonly AttributeDefinition[] {
  return type.attributes.filter(
    (attribute) =>
      attribute.type === "relationship" && attribute.relationship !== null,
  );
}

export function valueAttributes(
  type: ObjectType,
): readonly AttributeDefinition[] {
  return type.attributes.filter(
    (attribute) => attribute.type !== "relationship",
  );
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "12 min ago", "3 h ago", "yesterday", "9 days ago", or a date. */
export function relativeTimeLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const elapsed = Math.max(0, now.getTime() - then.getTime());
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function absoluteTimeLabel(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  return then.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
