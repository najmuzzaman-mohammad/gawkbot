import { describe, expect, it } from "vitest";

import type {
  AttributeDefinition,
  Cardinality,
  ObjectType,
  SchemaRelationship,
} from "../../../api/dataspaces";
import { relatedTypeNames, relationshipPairs } from "./schemaSummary";

function attribute(
  id: string,
  name: string,
  relationship: AttributeDefinition["relationship"] = null,
): AttributeDefinition {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    type: relationship ? "relationship" : "text",
    description: "",
    isPrimary: name === "Name",
    isRequired: false,
    isUnique: false,
    isMultivalue: false,
    options: [],
    currencyCode: null,
    relationship,
    createdBy: "cos",
  };
}

function objectType(
  id: string,
  name: string,
  namePlural: string,
  attributes: readonly AttributeDefinition[],
): ObjectType {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    namePlural,
    icon: "box",
    description: "",
    attributes: [attribute(`${id}_name`, "Name"), ...attributes],
    recordCount: 0,
    createdBy: "cos",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

/**
 * One relationship the store oriented from the to-MANY side: Firm owns it,
 * and Investor carries the mirror. The old inference prefers whichever side
 * is `many_to_one`, so it reads this pair backwards, which is exactly what
 * the server's own list is for.
 */
const FIRM_SIDE: AttributeDefinition["relationship"] = {
  relationshipId: "rel_1",
  targetTypeId: "type_investor",
  cardinality: "one_to_many",
  inverseAttributeId: "attr_firm",
};

const INVESTOR_SIDE: AttributeDefinition["relationship"] = {
  relationshipId: "rel_1",
  targetTypeId: "type_firm",
  cardinality: "many_to_one",
  inverseAttributeId: "attr_investors",
};

const FIRM = objectType("type_firm", "Firm", "Firms", [
  attribute("attr_investors", "Investors", FIRM_SIDE),
]);
const INVESTOR = objectType("type_investor", "Investor", "Investors", [
  attribute("attr_firm", "Firm", INVESTOR_SIDE),
]);
const TYPES: readonly ObjectType[] = [FIRM, INVESTOR];

const SERVER_ROWS: readonly SchemaRelationship[] = [
  {
    id: "rel_1",
    sourceTypeId: "type_firm",
    sourceAttributeId: "attr_investors",
    targetTypeId: "type_investor",
    inverseAttributeId: "attr_firm",
    cardinality: "one_to_many",
  },
];

describe("relationshipPairs", () => {
  it("takes the owning side from the server's list, not from the cardinality", () => {
    const [pair] = relationshipPairs(TYPES, SERVER_ROWS);

    expect(pair.sourceType.name).toBe("Firm");
    expect(pair.sourceAttribute.id).toBe("attr_investors");
    expect(pair.targetType.name).toBe("Investor");
    expect(pair.cardinality).toBe("one_to_many");
    expect(pair.inverseAttribute?.id).toBe("attr_firm");
  });

  it("infers the owning side only when the list is absent", () => {
    const [guessed] = relationshipPairs(TYPES);

    // The guess reads the pair from the to-one side, which is the wrong way
    // round for this relationship. It stays only as the fallback for a
    // broker that does not send the list.
    expect(guessed.sourceType.name).toBe("Investor");
    expect(guessed.sourceAttribute.id).toBe("attr_firm");
  });

  it("treats an empty list as no relationships, never as a missing list", () => {
    expect(relationshipPairs(TYPES, [])).toEqual([]);
  });

  it("skips a row whose types or attribute are not in the schema", () => {
    const orphan: SchemaRelationship = {
      id: "rel_2",
      sourceTypeId: "type_gone",
      sourceAttributeId: "attr_gone",
      targetTypeId: "type_firm",
      inverseAttributeId: null,
      cardinality: "many_to_one",
    };

    expect(relationshipPairs(TYPES, [...SERVER_ROWS, orphan])).toHaveLength(1);
  });

  it("carries a cardinality this version does not model without dropping the pair", () => {
    const unmodelled: readonly SchemaRelationship[] = [
      { ...SERVER_ROWS[0], cardinality: "link_graph" as Cardinality },
    ];

    expect(relationshipPairs(TYPES, unmodelled)[0].cardinality).toBe(
      "link_graph",
    );
  });
});

describe("relatedTypeNames", () => {
  it("names the to-many side in the plural and the to-one side in the singular", () => {
    expect(relatedTypeNames(FIRM, TYPES)).toEqual(["Investors"]);
    expect(relatedTypeNames(INVESTOR, TYPES)).toEqual(["Firm"]);
  });
});
