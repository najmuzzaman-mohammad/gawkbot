/**
 * Draft state and rules for the "New attribute" dialog. Pure: which controls
 * a type gets, what makes a draft valid, and the `AttributeInput` it becomes.
 */

import type { AttributeInput, AttributeType } from "../../../api/dataspaces";

export type ValueAttributeType = Exclude<AttributeType, "relationship">;

export interface DraftOption {
  /** Local list key only; the store mints the real option id. */
  key: string;
  name: string;
}

export interface AttributeDraft {
  type: ValueAttributeType;
  name: string;
  description: string;
  isRequired: boolean;
  isUnique: boolean;
  isMultivalue: boolean;
  options: readonly DraftOption[];
  currencyCode: string;
}

export const CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "INR",
  "JPY",
  "CAD",
  "AUD",
] as const;

export const DEFAULT_STATUS_OPTIONS_HINT =
  "Defaults to To do, In progress, Done.";

const UNIQUE_TYPES: readonly AttributeType[] = [
  "text",
  "email",
  "url",
  "phone",
  "number",
];
const MULTIVALUE_TYPES: readonly AttributeType[] = ["select", "email", "url"];
const OPTION_TYPES: readonly AttributeType[] = ["select", "status"];

/** One line per type for the picker, in plain words. */
export const ATTRIBUTE_TYPE_HINTS: Readonly<Record<AttributeType, string>> = {
  text: "Words, notes, or any short value.",
  number: "A count or a measurement.",
  currency: "An amount of money in one currency.",
  date: "A calendar day.",
  toggle: "Yes or no.",
  select: "One or more choices from a list you define.",
  status: "One stage in a process, such as To do or Done.",
  rating: "A score from 1 to 5.",
  url: "A web address.",
  email: "An email address.",
  phone: "A phone number.",
  relationship: "A link to records of another object type.",
};

export function supportsUnique(type: AttributeType): boolean {
  return UNIQUE_TYPES.includes(type);
}

export function supportsMultivalue(type: AttributeType): boolean {
  return MULTIVALUE_TYPES.includes(type);
}

export function hasOptions(type: AttributeType): boolean {
  return OPTION_TYPES.includes(type);
}

export function emptyAttributeDraft(type: ValueAttributeType): AttributeDraft {
  return {
    type,
    name: "",
    description: "",
    isRequired: false,
    isUnique: false,
    isMultivalue: false,
    options: [],
    currencyCode: CURRENCY_CODES[0],
  };
}

function filledOptionNames(draft: AttributeDraft): readonly string[] {
  return draft.options
    .map((option) => option.name.trim())
    .filter((name) => name !== "");
}

/** Validation message, or null when the draft can be submitted. */
export function validateAttributeDraft(draft: AttributeDraft): string | null {
  if (draft.name.trim() === "") return "The attribute needs a name.";
  if (hasOptions(draft.type)) {
    const names = filledOptionNames(draft);
    const lowered = names.map((name) => name.toLowerCase());
    const repeated = names.find(
      (_, index) => lowered.indexOf(lowered[index]) !== index,
    );
    if (repeated !== undefined) {
      return `Option "${repeated}" is listed twice. Option names must be unique.`;
    }
    if (draft.type === "select" && names.length === 0) {
      return "A select attribute needs at least one option.";
    }
  }
  return null;
}

/** Only the flags the type supports are sent; the rest stay off. */
export function attributeDraftToInput(draft: AttributeDraft): AttributeInput {
  const isUnique = supportsUnique(draft.type) && draft.isUnique;
  const base: AttributeInput = {
    name: draft.name.trim(),
    type: draft.type,
    description: draft.description.trim(),
    isRequired: draft.isRequired,
    isUnique,
    // A unique attribute holds one value, so unique wins over multiple.
    isMultivalue:
      supportsMultivalue(draft.type) && draft.isMultivalue && !isUnique,
  };
  if (hasOptions(draft.type)) {
    return { ...base, options: filledOptionNames(draft) };
  }
  if (draft.type === "currency") {
    return { ...base, currencyCode: draft.currencyCode };
  }
  return base;
}

let optionKeyCounter = 0;

/** Stable React key for a new option row. */
export function mintOptionKey(): string {
  optionKeyCounter += 1;
  return `draft-option-${optionKeyCounter}`;
}

export function moveOption(
  options: readonly DraftOption[],
  index: number,
  delta: -1 | 1,
): readonly DraftOption[] {
  const target = index + delta;
  if (index < 0 || index >= options.length) return options;
  if (target < 0 || target >= options.length) return options;
  const next = [...options];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
