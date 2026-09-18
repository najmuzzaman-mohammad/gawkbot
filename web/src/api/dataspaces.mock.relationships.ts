/**
 * Relationship attributes for the in-memory data client. One call creates the
 * owning attribute, the mirrored attribute on the target type, and the
 * relationship row, in a single state transition.
 */

import {
  type AttributeDefinition,
  type AttributeInput,
  CARDINALITIES,
  type Cardinality,
  type ObjectType,
  type RelationshipInput,
} from "./dataspaces";
import {
  assertNameFree,
  baseAttribute,
  type SchemaResult,
} from "./dataspaces.mock.attributes";
import {
  fail,
  MAX_ATTRIBUTES_PER_TYPE,
  type MockContext,
  requireType,
  type SpaceState,
  type StoredRelationship,
  sameName,
} from "./dataspaces.mock.store";

const INVERSE_CARDINALITY: Readonly<Record<Cardinality, Cardinality>> = {
  one_to_one: "one_to_one",
  many_to_one: "one_to_many",
  one_to_many: "many_to_one",
  many_to_many: "many_to_many",
};

export function flipCardinality(cardinality: Cardinality): Cardinality {
  return INVERSE_CARDINALITY[cardinality];
}

/** Validates a relationship input and resolves its target type. */
function relationshipTarget(
  state: SpaceState,
  type: ObjectType,
  input: AttributeInput,
  name: string,
): { rel: RelationshipInput; target: ObjectType } {
  const rel = input.relationship;
  if (!rel) {
    return fail(`${name}: a relationship attribute needs a target type.`);
  }
  if (input.isUnique || input.isMultivalue || input.isRequired) {
    fail(
      `${name}: relationship attributes do not take required, unique, or multivalue. Cardinality covers it.`,
    );
  }
  if ((input.options ?? []).length > 0) {
    fail(`${name}: options are only valid for select and status attributes.`);
  }
  if (!CARDINALITIES.includes(rel.cardinality)) {
    fail(
      `${name}: "${rel.cardinality}" is not a cardinality. Valid: ${CARDINALITIES.join(", ")}.`,
    );
  }
  if (rel.targetTypeId === type.id) {
    fail(`${name}: an object type cannot have a relationship to itself.`);
  }
  const target = requireType(state, rel.targetTypeId);
  assertNoDuplicateRelationship(state, type, target, name);
  return { rel, target };
}

/**
 * Same pair of types, in either orientation, with the same owning attribute
 * name: that is the same relationship asked for twice.
 */
function assertNoDuplicateRelationship(
  state: SpaceState,
  type: ObjectType,
  target: ObjectType,
  name: string,
) {
  const typeById = new Map(state.objectTypes.map((item) => [item.id, item]));
  for (const existing of state.relationships) {
    const samePair =
      (existing.sourceTypeId === type.id &&
        existing.targetTypeId === target.id) ||
      (existing.sourceTypeId === target.id &&
        existing.targetTypeId === type.id);
    const owner = typeById
      .get(existing.sourceTypeId)
      ?.attributes.find((item) => item.id === existing.sourceAttributeId);
    if (samePair && owner && sameName(owner.name, name)) {
      fail(
        `${type.name} and ${target.name} are already related through "${owner.name}". Reuse that relationship.`,
      );
    }
  }
}

export function addRelationship(
  state: SpaceState,
  ctx: MockContext,
  type: ObjectType,
  input: AttributeInput,
  name: string,
): SchemaResult<AttributeDefinition> {
  const { rel, target } = relationshipTarget(state, type, input, name);
  const relationshipId = ctx.mintId("rel");
  const inverseName = rel.inverseName.trim();
  let inverse: AttributeDefinition | null = null;
  if (inverseName !== "") {
    if (target.attributes.length >= MAX_ATTRIBUTES_PER_TYPE) {
      fail(`${target.name} already has ${MAX_ATTRIBUTES_PER_TYPE} attributes.`);
    }
    assertNameFree(target, inverseName);
    inverse = baseAttribute(ctx, target, inverseName, "relationship");
  }
  const owning: AttributeDefinition = {
    ...baseAttribute(ctx, type, name, "relationship"),
    description: input.description?.trim() ?? "",
    relationship: {
      relationshipId,
      targetTypeId: target.id,
      cardinality: rel.cardinality,
      inverseAttributeId: inverse?.id ?? null,
    },
  };
  const mirrored: AttributeDefinition | null = inverse && {
    ...inverse,
    relationship: {
      relationshipId,
      targetTypeId: type.id,
      cardinality: flipCardinality(rel.cardinality),
      inverseAttributeId: owning.id,
    },
  };
  const stored: StoredRelationship = {
    id: relationshipId,
    sourceTypeId: type.id,
    sourceAttributeId: owning.id,
    targetTypeId: target.id,
    inverseAttributeId: mirrored?.id ?? null,
    cardinality: rel.cardinality,
  };
  // Both attributes and the relationship row land in one state transition.
  const objectTypes = state.objectTypes.map((item) => {
    if (item.id === type.id) {
      return { ...item, attributes: [...item.attributes, owning] };
    }
    if (mirrored && item.id === target.id) {
      return { ...item, attributes: [...item.attributes, mirrored] };
    }
    return item;
  });
  return {
    state: {
      ...state,
      objectTypes,
      relationships: [...state.relationships, stored],
    },
    result: owning,
  };
}
