/**
 * Read-only views over spaces and schemas for the index screens. Pure.
 */

import type {
  AttributeDefinition,
  Cardinality,
  ObjectType,
  SchemaRelationship,
} from "../../../api/dataspaces";

export function relationshipAttributes(
  type: ObjectType,
): readonly AttributeDefinition[] {
  return type.attributes.filter((attribute) => attribute.relationship !== null);
}

/** Names of the types this type links to, without repeats: "Firm, Meetings". */
export function relatedTypeNames(
  type: ObjectType,
  objectTypes: readonly ObjectType[],
): readonly string[] {
  const byId = new Map(objectTypes.map((item) => [item.id, item]));
  const names: string[] = [];
  for (const attribute of relationshipAttributes(type)) {
    const target = byId.get(attribute.relationship?.targetTypeId ?? "");
    if (!target) continue;
    const isMany =
      attribute.relationship?.cardinality === "one_to_many" ||
      attribute.relationship?.cardinality === "many_to_many";
    const label = isMany ? target.namePlural : target.name;
    if (!names.includes(label)) names.push(label);
  }
  return names;
}

export interface RelationshipPair {
  relationshipId: string;
  sourceType: ObjectType;
  sourceAttribute: AttributeDefinition;
  targetType: ObjectType;
  /** Stated from the source side. */
  cardinality: Cardinality;
  inverseAttribute: AttributeDefinition | null;
}

interface RelationshipSide {
  type: ObjectType;
  attribute: AttributeDefinition;
}

/**
 * Fallback only, for a broker that does not send `Schema.Relationships`.
 * Without that list the schema carries a relationship as one attribute on
 * each side and never says which side owns it, so the owning side has to be
 * guessed: the to-one side reads most naturally first ("Investor . firm ->
 * Firm"), so a `many_to_one` side wins; otherwise the first side in type
 * order does. The guess is wrong for any pair the store oriented the other
 * way, which is exactly why the server states it.
 */
function pickSource(sides: readonly RelationshipSide[]): RelationshipSide {
  return (
    sides.find(
      (side) => side.attribute.relationship?.cardinality === "many_to_one",
    ) ?? sides[0]
  );
}

/** Both attributes of each relationship, in the order first seen. */
function collectSides(
  objectTypes: readonly ObjectType[],
): readonly (readonly RelationshipSide[])[] {
  const order: string[] = [];
  const sidesById = new Map<string, readonly RelationshipSide[]>();
  for (const type of objectTypes) {
    for (const attribute of relationshipAttributes(type)) {
      const id = attribute.relationship?.relationshipId ?? "";
      const existing = sidesById.get(id);
      if (existing === undefined) order.push(id);
      sidesById.set(id, [...(existing ?? []), { type, attribute }]);
    }
  }
  return order.map((id) => sidesById.get(id) ?? []);
}

function toPair(
  sides: readonly RelationshipSide[],
  byId: ReadonlyMap<string, ObjectType>,
): RelationshipPair | null {
  if (sides.length === 0) return null;
  const source = pickSource(sides);
  const ref = source.attribute.relationship;
  const targetType = ref ? byId.get(ref.targetTypeId) : undefined;
  if (!(ref && targetType)) return null;
  const inverse = sides.find((side) => side !== source) ?? null;
  return {
    relationshipId: ref.relationshipId,
    sourceType: source.type,
    sourceAttribute: source.attribute,
    targetType,
    cardinality: ref.cardinality,
    inverseAttribute: inverse?.attribute ?? null,
  };
}

function attributeById(
  type: ObjectType | undefined,
  attributeId: string | null,
): AttributeDefinition | null {
  if (!type || attributeId === null || attributeId === "") return null;
  return type.attributes.find((item) => item.id === attributeId) ?? null;
}

/** One server row, resolved against the types. Null when it does not resolve. */
function fromRow(
  row: SchemaRelationship,
  byId: ReadonlyMap<string, ObjectType>,
): RelationshipPair | null {
  const sourceType = byId.get(row.sourceTypeId);
  const targetType = byId.get(row.targetTypeId);
  const sourceAttribute = attributeById(sourceType, row.sourceAttributeId);
  if (!(sourceType && targetType && sourceAttribute)) return null;
  return {
    relationshipId: row.id,
    sourceType,
    sourceAttribute,
    targetType,
    cardinality: row.cardinality,
    inverseAttribute: attributeById(targetType, row.inverseAttributeId),
  };
}

/**
 * One entry per relationship, however many attributes express it.
 *
 * `relationships` is the store's own list and says which side owns each pair,
 * so it wins whenever it is there. Inference runs only when it is absent,
 * which means a broker older than that field.
 */
export function relationshipPairs(
  objectTypes: readonly ObjectType[],
  relationships?: readonly SchemaRelationship[],
): readonly RelationshipPair[] {
  const byId = new Map(objectTypes.map((item) => [item.id, item]));
  if (relationships !== undefined) {
    return relationships
      .map((row) => fromRow(row, byId))
      .filter((pair): pair is RelationshipPair => pair !== null);
  }
  return collectSides(objectTypes)
    .map((sides) => toPair(sides, byId))
    .filter((pair): pair is RelationshipPair => pair !== null);
}

/** "1 space", "3 spaces". */
export function countLabel(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
