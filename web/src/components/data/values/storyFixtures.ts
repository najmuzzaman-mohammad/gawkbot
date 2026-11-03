/**
 * One attribute definition per type, for stories and tests in this folder.
 * Deliberately local: the value layer must not depend on the mock client's
 * seed data, which has its own owner and its own lifecycle.
 */

import {
  type AttributeDefinition,
  type AttributeType,
  type AttributeValue,
  OPTION_COLORS,
  type SelectOption,
} from "../../../api/dataspaces";

const FIXTURE_CREATED_BY = "research-bot";

export function makeAttribute(
  type: AttributeType,
  overrides: Partial<AttributeDefinition> = {},
): AttributeDefinition {
  return {
    id: `attr_${type}`,
    slug: type,
    name: type,
    type,
    description: "",
    isPrimary: false,
    isRequired: false,
    isUnique: false,
    isMultivalue: false,
    options: [],
    currencyCode: null,
    relationship: null,
    createdBy: FIXTURE_CREATED_BY,
    ...overrides,
  };
}

/**
 * An attribute whose type this bundle does not model. The store owns that
 * set and can ship a value before the web app does, which is exactly the
 * case the fallback renderers exist for. Asserting past the union is the
 * simulation itself, and it is done here once so no test has to do it.
 */
export function makeUnknownTypeAttribute(
  type: string,
  overrides: Partial<AttributeDefinition> = {},
): AttributeDefinition {
  return {
    ...makeAttribute("text", overrides),
    id: `attr_${type}`,
    slug: type,
    name: overrides.name ?? type,
    type: type as AttributeType,
  };
}

/** One option per semantic color slot. */
export const COLOR_OPTIONS: readonly SelectOption[] = OPTION_COLORS.map(
  (color) => ({
    id: `opt_${color}`,
    name: `${color.charAt(0).toUpperCase()}${color.slice(1)}`,
    color,
  }),
);

export const STAGE_OPTIONS: readonly SelectOption[] = [
  { id: "opt_lead", name: "Lead", color: "neutral" },
  { id: "opt_qualified", name: "Qualified", color: "blue" },
  { id: "opt_progress", name: "In progress", color: "yellow" },
  { id: "opt_won", name: "Won", color: "green" },
  { id: "opt_lost", name: "Lost", color: "red" },
];

export const TAG_OPTIONS: readonly SelectOption[] = [
  { id: "opt_design", name: "Design partner", color: "purple" },
  { id: "opt_enterprise", name: "Enterprise", color: "blue" },
  { id: "opt_churn", name: "Churn risk", color: "red" },
  { id: "opt_referral", name: "Referral", color: "green" },
];

export const FIXTURE_ATTRIBUTES = {
  text: makeAttribute("text", { name: "Notes" }),
  number: makeAttribute("number", { name: "Seats" }),
  currency: makeAttribute("currency", {
    name: "Deal size",
    currencyCode: "USD",
  }),
  date: makeAttribute("date", { name: "Renewal date" }),
  toggle: makeAttribute("toggle", { name: "Is customer" }),
  select: makeAttribute("select", { name: "Stage", options: STAGE_OPTIONS }),
  multiSelect: makeAttribute("select", {
    id: "attr_tags",
    slug: "tags",
    name: "Tags",
    isMultivalue: true,
    options: TAG_OPTIONS,
  }),
  status: makeAttribute("status", { name: "Status", options: STAGE_OPTIONS }),
  rating: makeAttribute("rating", { name: "Fit" }),
  url: makeAttribute("url", { name: "Website" }),
  email: makeAttribute("email", { name: "Email" }),
  phone: makeAttribute("phone", { name: "Phone" }),
  relationship: makeAttribute("relationship", {
    name: "Company",
    relationship: {
      relationshipId: "rel_company",
      targetTypeId: "type_company",
      cardinality: "many_to_one",
      inverseAttributeId: null,
    },
  }),
} as const satisfies Readonly<Record<string, AttributeDefinition>>;

export type FixtureAttributeKey = keyof typeof FIXTURE_ATTRIBUTES;

export const LONG_TEXT =
  "Met at the operations summit. Runs a twelve person support team, wants every escalation summarised before standup, and asked for a follow-up once the shared inbox integration is ready for a pilot.";

export const FIXTURE_VALUES: Readonly<
  Record<FixtureAttributeKey, AttributeValue | undefined>
> = {
  text: "Warm intro from Dana",
  number: 1250,
  currency: 48000,
  date: "2026-09-17",
  toggle: true,
  select: "opt_qualified",
  multiSelect: ["opt_design", "opt_enterprise", "opt_referral"],
  status: "opt_progress",
  rating: 4,
  url: "dundermifflin.example/paper",
  email: "pam@dundermifflin.example",
  phone: "+1 (570) 555-0142",
  relationship: undefined,
};

/** Every inline-editable fixture, in a stable display order. */
export const EDITABLE_FIXTURE_KEYS: readonly FixtureAttributeKey[] = [
  "text",
  "number",
  "currency",
  "date",
  "toggle",
  "select",
  "multiSelect",
  "status",
  "rating",
  "url",
  "email",
  "phone",
];
