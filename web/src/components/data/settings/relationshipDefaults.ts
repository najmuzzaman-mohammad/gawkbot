/**
 * Pure rules for the relationship form: the four named cardinality modes,
 * default attribute names on both sides, and the plain-language preview.
 * "Source" is the object type being edited; "target" is the type it links to.
 * Cardinality is always stated from the source side.
 */

import type { Cardinality } from "../../../api/dataspaces";

export interface TypeNames {
  name: string;
  namePlural: string;
}

export interface RelationshipDraft {
  targetTypeId: string;
  /** Attribute name on the source type. */
  name: string;
  cardinality: Cardinality;
  hasInverse: boolean;
  /** Attribute name on the target type; ignored when `hasInverse` is off. */
  inverseName: string;
}

export const DEFAULT_RELATIONSHIP_CARDINALITY: Cardinality = "many_to_one";

export const CARDINALITY_MODE_LABELS: Readonly<Record<Cardinality, string>> = {
  one_to_one: "Exclusive Pair",
  many_to_one: "One Link per Source",
  one_to_many: "One Link per Target",
  many_to_many: "Open Linking",
};

const CARDINALITY_PLAIN: Readonly<Record<Cardinality, string>> = {
  one_to_one: "one to one",
  many_to_one: "many to one",
  one_to_many: "one to many",
  many_to_many: "many to many",
};

const FLIPPED: Readonly<Record<Cardinality, Cardinality>> = {
  one_to_one: "one_to_one",
  many_to_one: "one_to_many",
  one_to_many: "many_to_one",
  many_to_many: "many_to_many",
};

const PLACEHOLDER_TARGET: TypeNames = {
  name: "target",
  namePlural: "targets",
};

/**
 * Wording for a cardinality this bundle does not know. A bot can create a
 * relationship against a newer store while an older tab is open, and every
 * lookup below used to answer `undefined` for it: a blank label, and a
 * to-one reading that claimed a limit the store does not enforce.
 */
const UNKNOWN_MODE_LABEL = "Unknown link type";
const UNKNOWN_PLAIN = "an unknown shape";

/**
 * Widened to `string` on purpose. The maps above stay exhaustive over the
 * union, so adding a cardinality in TypeScript without wording for it is
 * still a compile error, while an unmodelled value resolves to the fallback.
 */
function lookup(
  table: Readonly<Record<Cardinality, string>>,
  cardinality: Cardinality,
  fallback: string,
): string {
  const widened: Readonly<Record<string, string | undefined>> = table;
  return widened[cardinality] ?? fallback;
}

export function cardinalityModeLabel(cardinality: Cardinality): string {
  return lookup(CARDINALITY_MODE_LABELS, cardinality, UNKNOWN_MODE_LABEL);
}

/** `many_to_one` reads as "many to one". */
export function cardinalityPlain(cardinality: Cardinality): string {
  return lookup(CARDINALITY_PLAIN, cardinality, UNKNOWN_PLAIN);
}

/** An unknown cardinality flips to itself: it is still just as unknown. */
export function flipCardinality(cardinality: Cardinality): Cardinality {
  const widened: Readonly<Record<string, Cardinality | undefined>> = FLIPPED;
  return widened[cardinality] ?? cardinality;
}

/**
 * True when a record on the owning side can link to many records. An
 * unrecognised cardinality answers true, because the permissive reading is
 * the safe one: claiming to-one would have the UI promise a limit this
 * version cannot know the store enforces.
 */
export function isToMany(cardinality: Cardinality): boolean {
  return cardinality !== "one_to_one" && cardinality !== "many_to_one";
}

function pluralOrName(names: TypeNames): string {
  const plural = names.namePlural.trim();
  return plural === "" ? names.name : plural;
}

/**
 * The attribute is named after what it points at: singular when it holds one
 * record, plural when it holds many. Display names keep the type's own
 * casing, the way every other attribute name does; the slug is lowercased by
 * the store.
 */
function nameFor(pointsAt: TypeNames, cardinality: Cardinality): string {
  return isToMany(cardinality) ? pluralOrName(pointsAt) : pointsAt.name;
}

export interface RelationshipNames {
  name: string;
  inverseName: string;
}

/** Empty until a target is chosen, so a half-filled form never looks done. */
export function defaultRelationshipNames(
  source: TypeNames,
  target: TypeNames | null,
  cardinality: Cardinality,
): RelationshipNames {
  if (target === null) return { name: "", inverseName: "" };
  return {
    name: nameFor(target, cardinality),
    inverseName: nameFor(source, flipCardinality(cardinality)),
  };
}

export interface ApplyDefaultsInput {
  current: RelationshipDraft;
  next: RelationshipDraft;
  source: TypeNames;
  currentTarget: TypeNames | null;
  nextTarget: TypeNames | null;
}

/**
 * Carries the default names forward when the target or cardinality changes,
 * without overwriting a name the operator typed. A name counts as untouched
 * when it is empty or still equals the default for the current settings.
 */
export function applyRelationshipNameDefaults({
  current,
  next,
  source,
  currentTarget,
  nextTarget,
}: ApplyDefaultsInput): RelationshipDraft {
  const before = defaultRelationshipNames(
    source,
    currentTarget,
    current.cardinality,
  );
  const after = defaultRelationshipNames(source, nextTarget, next.cardinality);
  const resolve = (
    currentValue: string,
    nextValue: string,
    beforeDefault: string,
    afterDefault: string,
  ): string => {
    // The operator is typing in this field right now; never fight them.
    if (nextValue !== currentValue) return nextValue;
    const isUntouched = currentValue === "" || currentValue === beforeDefault;
    return isUntouched ? afterDefault : currentValue;
  };
  return {
    ...next,
    name: resolve(current.name, next.name, before.name, after.name),
    inverseName: resolve(
      current.inverseName,
      next.inverseName,
      before.inverseName,
      after.inverseName,
    ),
  };
}

/** One sentence per mode, written with the two real type names. */
export function cardinalityModeExplanation(
  cardinality: Cardinality,
  source: TypeNames,
  target: TypeNames | null,
): string {
  const t = target ?? PLACEHOLDER_TARGET;
  const sources = pluralOrName(source);
  const targets = pluralOrName(t);
  switch (cardinality) {
    case "one_to_one":
      return `Each ${source.name} links to one ${t.name}, and each ${t.name} links to one ${source.name}.`;
    case "many_to_one":
      return `Each ${source.name} links to one ${t.name}, and one ${t.name} can have many ${sources}.`;
    case "one_to_many":
      return `Each ${t.name} links to one ${source.name}, and one ${source.name} can have many ${targets}.`;
    case "many_to_many":
      return `Any ${source.name} can link to many ${targets}, and any ${t.name} to many ${sources}.`;
    default: {
      // The binding keeps the switch exhaustive over the union; the sentence
      // is for a cardinality a newer store sent, which used to fall through
      // and render the raw wire value.
      const _exhaustive: never = cardinality;
      void _exhaustive;
      return `This version does not recognize how ${source.name} links to ${t.name}.`;
    }
  }
}

/**
 * Live preview under the form, e.g. "Each Investor links to one Firm. Each
 * Firm lists many Investors." Without an inverse attribute the second
 * sentence still states the limit, because cardinality applies either way.
 */
export function relationshipPreview(
  source: TypeNames,
  target: TypeNames | null,
  cardinality: Cardinality,
  hasInverse: boolean,
): string {
  if (target === null) return "Pick a target object type to see how it reads.";
  const sourceMany = isToMany(cardinality);
  const targetMany = isToMany(flipCardinality(cardinality));
  const forward = sourceMany
    ? `Each ${source.name} links to many ${pluralOrName(target)}.`
    : `Each ${source.name} links to one ${target.name}.`;
  const sourceCount = targetMany
    ? `many ${pluralOrName(source)}`
    : `one ${source.name}`;
  const backward = hasInverse
    ? `Each ${target.name} lists ${sourceCount}.`
    : `Each ${target.name} can be linked from ${sourceCount}, with no attribute added on ${target.name}.`;
  return `${forward} ${backward}`;
}

/** Validation message for the form, or null when it can be submitted. */
export function validateRelationshipDraft(
  draft: RelationshipDraft,
): string | null {
  if (draft.targetTypeId === "") return "Pick a target object type.";
  if (draft.name.trim() === "") return "The attribute needs a name.";
  if (draft.hasInverse && draft.inverseName.trim() === "") {
    return "The attribute on the target needs a name, or turn it off.";
  }
  return null;
}
