import { describe, expect, it } from "vitest";

import { CARDINALITIES } from "../../../api/dataspaces";
import {
  applyRelationshipNameDefaults,
  cardinalityModeExplanation,
  cardinalityModeLabel,
  cardinalityPlain,
  defaultRelationshipNames,
  flipCardinality,
  type RelationshipDraft,
  relationshipPreview,
  validateRelationshipDraft,
} from "./relationshipDefaults";

const INVESTOR = { name: "Investor", namePlural: "Investors" };
const FIRM = { name: "Firm", namePlural: "Firms" };
const MEETING = { name: "Meeting", namePlural: "Meetings" };

const BASE: RelationshipDraft = {
  targetTypeId: "",
  name: "",
  cardinality: "many_to_one",
  hasInverse: true,
  inverseName: "",
};

describe("cardinality modes", () => {
  it("names the four modes from the spec", () => {
    expect(CARDINALITIES.map(cardinalityModeLabel)).toEqual([
      "Exclusive Pair",
      "One Link per Source",
      "One Link per Target",
      "Open Linking",
    ]);
    expect(cardinalityPlain("many_to_one")).toBe("many to one");
  });

  it("flips to the other side's point of view", () => {
    expect(flipCardinality("many_to_one")).toBe("one_to_many");
    expect(flipCardinality("one_to_many")).toBe("many_to_one");
    expect(flipCardinality("one_to_one")).toBe("one_to_one");
    expect(flipCardinality("many_to_many")).toBe("many_to_many");
  });

  it("explains each mode with the two real type names", () => {
    expect(cardinalityModeExplanation("many_to_one", INVESTOR, FIRM)).toBe(
      "Each Investor links to one Firm, and one Firm can have many Investors.",
    );
    expect(cardinalityModeExplanation("one_to_many", INVESTOR, FIRM)).toBe(
      "Each Firm links to one Investor, and one Investor can have many Firms.",
    );
    expect(cardinalityModeExplanation("one_to_one", INVESTOR, FIRM)).toBe(
      "Each Investor links to one Firm, and each Firm links to one Investor.",
    );
    expect(cardinalityModeExplanation("many_to_many", INVESTOR, FIRM)).toBe(
      "Any Investor can link to many Firms, and any Firm to many Investors.",
    );
  });

  it("uses a placeholder until a target is picked", () => {
    expect(cardinalityModeExplanation("many_to_one", INVESTOR, null)).toContain(
      "one target",
    );
  });
});

describe("defaultRelationshipNames", () => {
  it("is empty until a target is picked", () => {
    expect(defaultRelationshipNames(INVESTOR, null, "many_to_one")).toEqual({
      name: "",
      inverseName: "",
    });
  });

  it.each([
    ["many_to_one", "Firm", "Investors"],
    ["one_to_many", "Firms", "Investor"],
    ["one_to_one", "Firm", "Investor"],
    ["many_to_many", "Firms", "Investors"],
  ] as const)("%s names this side %s and the inverse %s", (cardinality, name, inverseName) => {
    expect(defaultRelationshipNames(INVESTOR, FIRM, cardinality)).toEqual({
      name,
      inverseName,
    });
  });

  it("falls back to the singular when a type has no plural", () => {
    const bare = { name: "Deal", namePlural: " " };
    expect(defaultRelationshipNames(INVESTOR, bare, "many_to_many").name).toBe(
      "Deal",
    );
  });
});

describe("applyRelationshipNameDefaults", () => {
  it("seeds both names when the target is first picked", () => {
    const next = { ...BASE, targetTypeId: "firm" };
    expect(
      applyRelationshipNameDefaults({
        current: BASE,
        next,
        source: INVESTOR,
        currentTarget: null,
        nextTarget: FIRM,
      }),
    ).toMatchObject({ name: "Firm", inverseName: "Investors" });
  });

  it("follows a cardinality change while the names are untouched", () => {
    const current = {
      ...BASE,
      targetTypeId: "firm",
      name: "Firm",
      inverseName: "Investors",
    };
    const next: RelationshipDraft = { ...current, cardinality: "many_to_many" };
    expect(
      applyRelationshipNameDefaults({
        current,
        next,
        source: INVESTOR,
        currentTarget: FIRM,
        nextTarget: FIRM,
      }),
    ).toMatchObject({ name: "Firms", inverseName: "Investors" });
  });

  it("follows a target change while the names are untouched", () => {
    const current = {
      ...BASE,
      targetTypeId: "firm",
      name: "Firm",
      inverseName: "Investors",
    };
    const next = { ...current, targetTypeId: "meeting" };
    expect(
      applyRelationshipNameDefaults({
        current,
        next,
        source: INVESTOR,
        currentTarget: FIRM,
        nextTarget: MEETING,
      }),
    ).toMatchObject({ name: "Meeting", inverseName: "Investors" });
  });

  it("never overwrites a name the operator typed", () => {
    const current = {
      ...BASE,
      targetTypeId: "firm",
      name: "Lead firm",
      inverseName: "Investors",
    };
    const next: RelationshipDraft = { ...current, cardinality: "one_to_one" };
    expect(
      applyRelationshipNameDefaults({
        current,
        next,
        source: INVESTOR,
        currentTarget: FIRM,
        nextTarget: FIRM,
      }),
    ).toMatchObject({ name: "Lead firm", inverseName: "Investor" });
  });

  it("passes through the keystroke in the field being typed", () => {
    const current = {
      ...BASE,
      targetTypeId: "firm",
      name: "Firm",
      inverseName: "Investors",
    };
    const next = { ...current, name: "Firmx" };
    expect(
      applyRelationshipNameDefaults({
        current,
        next,
        source: INVESTOR,
        currentTarget: FIRM,
        nextTarget: FIRM,
      }).name,
    ).toBe("Firmx");
  });
});

describe("relationshipPreview", () => {
  it("reads as two sentences for the spec example", () => {
    expect(relationshipPreview(INVESTOR, FIRM, "many_to_one", true)).toBe(
      "Each Investor links to one Firm. Each Firm lists many Investors.",
    );
  });

  it("covers to-many on this side and to-one on the other", () => {
    expect(relationshipPreview(INVESTOR, MEETING, "one_to_many", true)).toBe(
      "Each Investor links to many Meetings. Each Meeting lists one Investor.",
    );
  });

  it("still states the limit when no inverse attribute is added", () => {
    expect(relationshipPreview(INVESTOR, FIRM, "many_to_one", false)).toBe(
      "Each Investor links to one Firm. Each Firm can be linked from many Investors, with no attribute added on Firm.",
    );
  });

  it("asks for a target first", () => {
    expect(relationshipPreview(INVESTOR, null, "many_to_one", true)).toBe(
      "Pick a target object type to see how it reads.",
    );
  });
});

describe("validateRelationshipDraft", () => {
  it("walks the required fields in order", () => {
    expect(validateRelationshipDraft(BASE)).toBe("Pick a target object type.");
    expect(validateRelationshipDraft({ ...BASE, targetTypeId: "firm" })).toBe(
      "The attribute needs a name.",
    );
    expect(
      validateRelationshipDraft({
        ...BASE,
        targetTypeId: "firm",
        name: "Firm",
      }),
    ).toBe("The attribute on the target needs a name, or turn it off.");
    expect(
      validateRelationshipDraft({
        ...BASE,
        targetTypeId: "firm",
        name: "Firm",
        hasInverse: false,
      }),
    ).toBeNull();
  });
});
