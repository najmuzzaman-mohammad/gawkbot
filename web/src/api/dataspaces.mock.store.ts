/**
 * State shape and read-side helpers for the in-memory data client.
 *
 * A `SpaceState` is an immutable snapshot. Every engine operation in the
 * sibling `dataspaces.mock.*.ts` files is a pure function that takes a state
 * and returns the next one, so a failed validation can never leave a space
 * half-written and a relationship pair is created atomically for free.
 */

import {
  type AttributeDefinition,
  type AttributeValue,
  type DataRecord,
  type DataSpace,
  DataValidationError,
  type ObjectType,
  type RecordRef,
  type SchemaRelationship,
  type SpaceSchema,
} from "./dataspaces";

export const ACTOR_HUMAN = "human";
export const MAX_OBJECT_TYPES_PER_SPACE = 50;
export const MAX_ATTRIBUTES_PER_TYPE = 100;
export const PRIMARY_ATTRIBUTE_SLUG = "name";
export const DEFAULT_OBJECT_TYPE_ICON = "box";

export interface StoredRecord {
  id: string;
  typeId: string;
  values: Readonly<Record<string, AttributeValue>>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row per relationship, oriented from the attribute that was created
 * first (the owning side). `cardinality` is stated from that side. This is
 * the stored form of the `SchemaRelationship` every read hands back, so the
 * two shapes are pinned to each other.
 */
export type StoredRelationship = SchemaRelationship;

/** `sourceId` is a record of the relationship's source type. */
export interface StoredLink {
  relationshipId: string;
  sourceId: string;
  targetId: string;
}

export interface SpaceState {
  /** Counts on `space` and `objectTypes` are recomputed on every read. */
  space: DataSpace;
  objectTypes: readonly ObjectType[];
  relationships: readonly StoredRelationship[];
  records: readonly StoredRecord[];
  links: readonly StoredLink[];
}

/** Injected so fixtures and tests get deterministic ids and timestamps. */
export interface MockContext {
  now(): Date;
  /** Returns a fresh id such as `rec_k3f9x2ab`. */
  mintId(prefix: string): string;
  /** Bot slug or "human"; stamped into `createdBy`. */
  actor: string;
}

export function fail(message: string, attribute: string | null = null): never {
  throw new DataValidationError(message, attribute);
}

/** Every value in the store is plain JSON, so a JSON round trip is a deep copy. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug === "" ? fallback : slug;
}

export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function requireType(state: SpaceState, typeId: string): ObjectType {
  const found = state.objectTypes.find((type) => type.id === typeId);
  if (!found) {
    const known = state.objectTypes.map((type) => type.id).join(", ");
    return fail(
      `Unknown object type "${typeId}". Known object types: ${known || "none"}.`,
    );
  }
  return found;
}

export function requireRecord(
  state: SpaceState,
  recordId: string,
): StoredRecord {
  const found = state.records.find((record) => record.id === recordId);
  if (!found) return fail(`Unknown record "${recordId}".`);
  return found;
}

export function primaryAttribute(type: ObjectType): AttributeDefinition {
  const found = type.attributes.find((attribute) => attribute.isPrimary);
  if (!found) return fail(`${type.name} has no primary attribute.`);
  return found;
}

export function requireRelationship(
  state: SpaceState,
  relationshipId: string,
): StoredRelationship {
  const found = state.relationships.find((rel) => rel.id === relationshipId);
  if (!found) return fail(`Unknown relationship "${relationshipId}".`);
  return found;
}

export function replaceType(state: SpaceState, next: ObjectType): SpaceState {
  return {
    ...state,
    objectTypes: state.objectTypes.map((type) =>
      type.id === next.id ? next : type,
    ),
  };
}

export function viewObjectType(
  state: SpaceState,
  type: ObjectType,
): ObjectType {
  const recordCount = state.records.filter(
    (record) => record.typeId === type.id,
  ).length;
  return { ...deepClone(type), recordCount };
}

export function viewSpace(state: SpaceState): DataSpace {
  return {
    ...deepClone(state.space),
    objectTypeCount: state.objectTypes.length,
    recordCount: state.records.length,
  };
}

/**
 * The server states each relationship as a row of its own, so consumers never
 * have to guess which of the two attributes owns it. The mock is the oracle
 * for that contract, so it hands the list back on every read.
 */
export function viewSchema(state: SpaceState): SpaceSchema {
  return {
    space: viewSpace(state),
    objectTypes: state.objectTypes.map((type) => viewObjectType(state, type)),
    relationships: deepClone(state.relationships),
  };
}

export type RecordViewer = (record: StoredRecord) => DataRecord;

/**
 * Builds the lookup tables once, then resolves any number of records into
 * their wire shape. `RecordRef.name` is read from the target's current
 * primary value at view time, so it can never go stale.
 */
export function createRecordViewer(state: SpaceState): RecordViewer {
  const typesById = new Map(state.objectTypes.map((type) => [type.id, type]));
  const recordsById = new Map(state.records.map((rec) => [rec.id, rec]));
  const relationshipsById = new Map(
    state.relationships.map((rel) => [rel.id, rel]),
  );

  const toRef = (recordId: string): RecordRef | null => {
    const record = recordsById.get(recordId);
    const type = record ? typesById.get(record.typeId) : undefined;
    if (!(record && type)) return null;
    const primary = primaryAttribute(type);
    const raw = record.values[primary.slug];
    return { id: record.id, typeId: type.id, name: String(raw ?? "") };
  };

  return (record) => {
    const type = typesById.get(record.typeId);
    const links: Record<string, readonly RecordRef[]> = {};
    for (const attribute of type?.attributes ?? []) {
      const ref = attribute.relationship;
      if (!ref) continue;
      const rel = relationshipsById.get(ref.relationshipId);
      if (!rel) continue;
      const isSource = rel.sourceAttributeId === attribute.id;
      const otherIds = state.links
        .filter((link) => link.relationshipId === rel.id)
        .filter((link) =>
          isSource ? link.sourceId === record.id : link.targetId === record.id,
        )
        .map((link) => (isSource ? link.targetId : link.sourceId));
      links[attribute.slug] = otherIds
        .map(toRef)
        .filter((item): item is RecordRef => item !== null);
    }
    return {
      id: record.id,
      typeId: record.typeId,
      values: deepClone(record.values),
      links,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  };
}
