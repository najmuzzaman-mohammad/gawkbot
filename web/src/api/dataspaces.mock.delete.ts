/**
 * Two-phase deletes for the in-memory data client: `planDelete` resolves an
 * id set into everything that goes with it and counts the impact;
 * `applyDelete` removes it. The token that joins the two lives in
 * `dataspaces.mock.ts`.
 */

import type {
  AttributeDefinition,
  DeleteImpact,
  DeleteKind,
  ObjectType,
} from "./dataspaces";
import { fail, type SpaceState } from "./dataspaces.mock.store";

export const DELETE_TOKEN_TTL_MS = 15 * 60 * 1000;
const DELETE_KINDS: readonly DeleteKind[] = [
  "space",
  "object_type",
  "attribute",
  "records",
];

export interface DeletePlan {
  deletesSpace: boolean;
  typeIds: ReadonlySet<string>;
  attributeIds: ReadonlySet<string>;
  relationshipIds: ReadonlySet<string>;
  recordIds: ReadonlySet<string>;
  /**
   * `attributes` counts every attribute removed, including mirrored ones and
   * relationship attributes on surviving types. `records` counts records that
   * are removed or, for an attribute delete, that lose a stored value.
   */
  impact: DeleteImpact;
}

/** Order-independent and duplicate-free, so a token binds to a set. */
export function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function planRecords(state: SpaceState, ids: readonly string[]): DeletePlan {
  const known = new Set(state.records.map((record) => record.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) fail(`Unknown record ids: ${missing.join(", ")}.`);
  const recordIds = new Set(ids);
  const links = state.links.filter(
    (link) => recordIds.has(link.sourceId) || recordIds.has(link.targetId),
  );
  return {
    deletesSpace: false,
    typeIds: new Set(),
    attributeIds: new Set(),
    relationshipIds: new Set(),
    recordIds,
    impact: {
      records: recordIds.size,
      links: links.length,
      attributes: 0,
      objectTypes: 0,
    },
  };
}

function deletableAttribute(
  state: SpaceState,
  attributeId: string,
): { type: ObjectType; attribute: AttributeDefinition } {
  for (const type of state.objectTypes) {
    const attribute = type.attributes.find((item) => item.id === attributeId);
    if (!attribute) continue;
    if (attribute.isPrimary) {
      fail(
        `"${attribute.name}" is the primary attribute of ${type.name} and cannot be deleted.`,
        attribute.slug,
      );
    }
    return { type, attribute };
  }
  return fail(`Unknown attribute id "${attributeId}".`);
}

function planAttributes(state: SpaceState, ids: readonly string[]): DeletePlan {
  const attributeIds = new Set<string>();
  const relationshipIds = new Set<string>();
  const losingValue = new Set<string>();
  for (const id of ids) {
    const { type, attribute } = deletableAttribute(state, id);
    attributeIds.add(attribute.id);
    if (attribute.relationship) {
      // The mirrored attribute and every link go with it.
      relationshipIds.add(attribute.relationship.relationshipId);
      const mirrored = attribute.relationship.inverseAttributeId;
      if (mirrored) attributeIds.add(mirrored);
      continue;
    }
    const holders = state.records
      .filter((record) => record.typeId === type.id)
      .filter((record) => record.values[attribute.slug] !== undefined);
    for (const record of holders) losingValue.add(record.id);
  }
  const links = state.links.filter((link) =>
    relationshipIds.has(link.relationshipId),
  );
  return {
    deletesSpace: false,
    typeIds: new Set(),
    attributeIds,
    relationshipIds,
    recordIds: new Set(),
    impact: {
      records: losingValue.size,
      links: links.length,
      attributes: attributeIds.size,
      objectTypes: 0,
    },
  };
}

function planTypes(state: SpaceState, ids: readonly string[]): DeletePlan {
  const known = new Set(state.objectTypes.map((type) => type.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    fail(`Unknown object type ids: ${missing.join(", ")}.`);
  }
  const typeIds = new Set(ids);
  const relationships = state.relationships.filter(
    (rel) => typeIds.has(rel.sourceTypeId) || typeIds.has(rel.targetTypeId),
  );
  const relationshipIds = new Set(relationships.map((rel) => rel.id));
  const attributeIds = new Set<string>();
  for (const type of state.objectTypes) {
    for (const attribute of type.attributes) {
      const pointsAtDeleted =
        attribute.relationship !== null &&
        relationshipIds.has(attribute.relationship.relationshipId);
      if (typeIds.has(type.id) || pointsAtDeleted) {
        attributeIds.add(attribute.id);
      }
    }
  }
  const recordIds = new Set(
    state.records
      .filter((record) => typeIds.has(record.typeId))
      .map((record) => record.id),
  );
  const links = state.links.filter((link) =>
    relationshipIds.has(link.relationshipId),
  );
  return {
    deletesSpace: false,
    typeIds,
    attributeIds,
    relationshipIds,
    recordIds,
    impact: {
      records: recordIds.size,
      links: links.length,
      attributes: attributeIds.size,
      objectTypes: typeIds.size,
    },
  };
}

export function planDelete(
  state: SpaceState,
  kind: DeleteKind,
  rawIds: readonly string[],
): DeletePlan {
  if (!DELETE_KINDS.includes(kind)) {
    fail(
      `"${kind}" cannot be deleted. Valid kinds: ${DELETE_KINDS.join(", ")}.`,
    );
  }
  const ids = normalizeIds(rawIds);
  if (ids.length === 0) fail("Nothing to delete: the id list is empty.");
  if (kind === "records") return planRecords(state, ids);
  if (kind === "attribute") return planAttributes(state, ids);
  if (kind === "object_type") return planTypes(state, ids);
  if (ids.length !== 1 || ids[0] !== state.space.id) {
    fail(`A space delete takes exactly the space id "${state.space.id}".`);
  }
  const everything = planTypes(
    state,
    state.objectTypes.map((type) => type.id),
  );
  return { ...everything, deletesSpace: true };
}

/** Returns `null` when the plan deletes the whole space. */
export function applyDelete(
  state: SpaceState,
  plan: DeletePlan,
): SpaceState | null {
  if (plan.deletesSpace) return null;
  const objectTypes = state.objectTypes
    .filter((type) => !plan.typeIds.has(type.id))
    .map((type) => ({
      ...type,
      attributes: type.attributes.filter(
        (attribute) => !plan.attributeIds.has(attribute.id),
      ),
    }));
  // Values are keyed by slug, so collect the removed slugs per type.
  const removedSlugs = new Map<string, ReadonlySet<string>>(
    state.objectTypes.map((type) => [
      type.id,
      new Set(
        type.attributes
          .filter((attribute) => plan.attributeIds.has(attribute.id))
          .map((attribute) => attribute.slug),
      ),
    ]),
  );
  const records = state.records
    .filter((record) => !plan.recordIds.has(record.id))
    .map((record) => {
      const slugs = removedSlugs.get(record.typeId);
      if (!slugs || slugs.size === 0) return record;
      const values = Object.fromEntries(
        Object.entries(record.values).filter(([slug]) => !slugs.has(slug)),
      );
      return { ...record, values };
    });
  return {
    ...state,
    objectTypes,
    records,
    relationships: state.relationships.filter(
      (rel) => !plan.relationshipIds.has(rel.id),
    ),
    links: state.links.filter(
      (link) =>
        !(
          plan.relationshipIds.has(link.relationshipId) ||
          plan.recordIds.has(link.sourceId) ||
          plan.recordIds.has(link.targetId)
        ),
    ),
  };
}
