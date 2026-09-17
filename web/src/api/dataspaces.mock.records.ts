/**
 * Record and link operations for the in-memory data client. Pure functions
 * over `SpaceState`; cardinality is enforced on both sides of a relationship.
 */

import type { AttributeDefinition, ObjectType } from "./dataspaces";
import {
  fail,
  type MockContext,
  primaryAttribute,
  requireRecord,
  requireRelationship,
  requireType,
  type SpaceState,
  type StoredLink,
  type StoredRecord,
  type StoredRelationship,
} from "./dataspaces.mock.store";
import { applyValuesPatch } from "./dataspaces.mock.values";

export interface RecordResult {
  state: SpaceState;
  record: StoredRecord;
}

export function createRecord(
  state: SpaceState,
  ctx: MockContext,
  typeId: string,
  values: Readonly<Record<string, unknown>>,
): RecordResult {
  const type = requireType(state, typeId);
  const stamp = ctx.now().toISOString();
  const record: StoredRecord = {
    id: ctx.mintId("rec"),
    typeId,
    values: applyValuesPatch(state, type, values, null),
    createdBy: ctx.actor,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return { state: { ...state, records: [...state.records, record] }, record };
}

export function updateRecord(
  state: SpaceState,
  ctx: MockContext,
  recordId: string,
  values: Readonly<Record<string, unknown>>,
): RecordResult {
  const existing = requireRecord(state, recordId);
  const type = requireType(state, existing.typeId);
  const record: StoredRecord = {
    ...existing,
    values: applyValuesPatch(state, type, values, existing),
    updatedAt: ctx.now().toISOString(),
  };
  return { state: replaceRecords(state, [record]), record };
}

function replaceRecords(
  state: SpaceState,
  changed: readonly StoredRecord[],
): SpaceState {
  const byId = new Map(changed.map((record) => [record.id, record]));
  return {
    ...state,
    records: state.records.map((record) => byId.get(record.id) ?? record),
  };
}

function touch(
  state: SpaceState,
  ctx: MockContext,
  recordIds: readonly string[],
): SpaceState {
  const stamp = ctx.now().toISOString();
  const ids = new Set(recordIds);
  return {
    ...state,
    records: state.records.map((record) =>
      ids.has(record.id) ? { ...record, updatedAt: stamp } : record,
    ),
  };
}

function nameOf(state: SpaceState, record: StoredRecord): string {
  const type = requireType(state, record.typeId);
  const label = String(record.values[primaryAttribute(type).slug] ?? "");
  return label === "" ? record.id : label;
}

interface ResolvedLink {
  record: StoredRecord;
  target: StoredRecord;
  type: ObjectType;
  targetType: ObjectType;
  attribute: AttributeDefinition;
  relationship: StoredRelationship;
  /** The pair, oriented the way the relationship stores it. */
  link: StoredLink;
}

function resolveLink(
  state: SpaceState,
  recordId: string,
  attributeSlug: string,
  targetId: string,
): ResolvedLink {
  const record = requireRecord(state, recordId);
  const type = requireType(state, record.typeId);
  const attribute = type.attributes.find((item) => item.slug === attributeSlug);
  if (!attribute) {
    const slugs = type.attributes
      .filter((item) => item.type === "relationship")
      .map((item) => item.slug);
    return fail(
      `"${attributeSlug}" is not an attribute of ${type.name}. Relationship attributes: ${slugs.join(", ") || "none"}.`,
      attributeSlug,
    );
  }
  if (attribute.type !== "relationship" || !attribute.relationship) {
    return fail(
      `"${attributeSlug}" is a ${attribute.type} attribute, not a relationship. Use updateRecord to set its value.`,
      attributeSlug,
    );
  }
  const target = requireRecord(state, targetId);
  const targetType = requireType(state, attribute.relationship.targetTypeId);
  if (target.typeId !== targetType.id) {
    const actual = requireType(state, target.typeId);
    fail(
      `${attribute.name} links to ${targetType.name} records; ${target.id} is a ${actual.name}.`,
      attributeSlug,
    );
  }
  const relationship = requireRelationship(
    state,
    attribute.relationship.relationshipId,
  );
  const fromSource = relationship.sourceAttributeId === attribute.id;
  const link: StoredLink = {
    relationshipId: relationship.id,
    sourceId: fromSource ? record.id : target.id,
    targetId: fromSource ? target.id : record.id,
  };
  return { record, target, type, targetType, attribute, relationship, link };
}

function sameLink(a: StoredLink, b: StoredLink): boolean {
  return (
    a.relationshipId === b.relationshipId &&
    a.sourceId === b.sourceId &&
    a.targetId === b.targetId
  );
}

function conflictMessage(
  state: SpaceState,
  resolved: ResolvedLink,
  conflict: StoredLink,
): string {
  const { record, target, type, targetType, attribute, link } = resolved;
  const callerIsSource = link.sourceId === record.id;
  const callerSideBlocked = callerIsSource
    ? conflict.sourceId === record.id
    : conflict.targetId === record.id;
  if (callerSideBlocked) {
    const heldId = callerIsSource ? conflict.targetId : conflict.sourceId;
    const held = nameOf(state, requireRecord(state, heldId));
    return `${nameOf(state, record)} is already linked to ${held} through ${attribute.name}, which holds one ${targetType.name}. Pass replace to swap it for ${nameOf(state, target)}.`;
  }
  const ownerId = callerIsSource ? conflict.sourceId : conflict.targetId;
  const owner = nameOf(state, requireRecord(state, ownerId));
  return `${nameOf(state, target)} is already linked to ${owner}, and each ${targetType.name} can belong to one ${type.name} through ${attribute.name}. Pass replace to move it to ${nameOf(state, record)}.`;
}

export function linkRecords(
  state: SpaceState,
  ctx: MockContext,
  recordId: string,
  attributeSlug: string,
  targetId: string,
  replace: boolean,
): RecordResult {
  const resolved = resolveLink(state, recordId, attributeSlug, targetId);
  const { link, relationship } = resolved;
  if (state.links.some((existing) => sameLink(existing, link))) {
    // Already linked: an idempotent no-op, nothing is touched.
    return { state, record: resolved.record };
  }
  const { cardinality } = relationship;
  const sourceHoldsOne =
    cardinality === "many_to_one" || cardinality === "one_to_one";
  const targetHoldsOne =
    cardinality === "one_to_many" || cardinality === "one_to_one";
  const conflicts = state.links.filter(
    (existing) =>
      existing.relationshipId === link.relationshipId &&
      ((sourceHoldsOne && existing.sourceId === link.sourceId) ||
        (targetHoldsOne && existing.targetId === link.targetId)),
  );
  if (conflicts.length > 0 && !replace) {
    fail(conflictMessage(state, resolved, conflicts[0]), attributeSlug);
  }
  const kept = state.links.filter((existing) => !conflicts.includes(existing));
  const touched = [
    link.sourceId,
    link.targetId,
    ...conflicts.flatMap((conflict) => [conflict.sourceId, conflict.targetId]),
  ];
  const next = touch({ ...state, links: [...kept, link] }, ctx, touched);
  return { state: next, record: requireRecord(next, recordId) };
}

export function unlinkRecords(
  state: SpaceState,
  ctx: MockContext,
  recordId: string,
  attributeSlug: string,
  targetId: string,
): RecordResult {
  const resolved = resolveLink(state, recordId, attributeSlug, targetId);
  const { link } = resolved;
  if (!state.links.some((existing) => sameLink(existing, link))) {
    // Not linked: an idempotent no-op.
    return { state, record: resolved.record };
  }
  const links = state.links.filter((existing) => !sameLink(existing, link));
  const next = touch({ ...state, links }, ctx, [link.sourceId, link.targetId]);
  return { state: next, record: requireRecord(next, recordId) };
}
