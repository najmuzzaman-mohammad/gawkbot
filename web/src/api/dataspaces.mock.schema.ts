/**
 * Schema operations for the in-memory data client: object types, attributes,
 * select options, and relationship pairs. Pure functions over `SpaceState`.
 */

import {
  ATTRIBUTE_TYPES,
  type AttributeDefinition,
  type AttributeInput,
  type AttributePatch,
  type AttributeType,
  type ObjectType,
  type ObjectTypeInput,
  OPTION_COLORS,
  type SelectOption,
} from "./dataspaces";
import {
  assertNameFree,
  baseAttribute,
  cleanName,
  type SchemaResult,
} from "./dataspaces.mock.attributes";
import { addRelationship } from "./dataspaces.mock.relationships";
import {
  DEFAULT_OBJECT_TYPE_ICON,
  fail,
  MAX_ATTRIBUTES_PER_TYPE,
  MAX_OBJECT_TYPES_PER_SPACE,
  type MockContext,
  PRIMARY_ATTRIBUTE_SLUG,
  replaceType,
  requireType,
  type SpaceState,
  sameName,
  slugify,
  uniqueSlug,
} from "./dataspaces.mock.store";

export type { SchemaResult } from "./dataspaces.mock.attributes";
export { flipCardinality } from "./dataspaces.mock.relationships";

export const DEFAULT_STATUS_OPTIONS = ["To do", "In progress", "Done"] as const;
export const DEFAULT_CURRENCY_CODE = "USD";
const MULTIVALUE_TYPES: readonly AttributeType[] = ["select", "email", "url"];
const OPTION_TYPES: readonly AttributeType[] = ["select", "status"];
const ATTRIBUTE_PATCH_KEYS: readonly string[] = [
  "name",
  "description",
  "isRequired",
  "addOptions",
  "renameOption",
];
const IMMUTABLE_ATTRIBUTE_KEYS: readonly string[] = [
  "type",
  "isUnique",
  "isMultivalue",
  "slug",
];

function mintOptions(
  ctx: MockContext,
  names: readonly string[],
  startIndex: number,
): SelectOption[] {
  return names.map((name, index) => ({
    id: ctx.mintId("opt"),
    name,
    color: OPTION_COLORS[(startIndex + index) % OPTION_COLORS.length],
  }));
}

function cleanOptionNames(raw: readonly string[] | undefined): string[] {
  const names = (raw ?? []).map((name) => cleanName(name, "An option"));
  names.forEach((name, index) => {
    if (names.findIndex((other) => sameName(other, name)) !== index) {
      fail(`Option "${name}" is listed twice. Option names must be unique.`);
    }
  });
  return names;
}

export function createObjectType(
  state: SpaceState,
  ctx: MockContext,
  input: ObjectTypeInput,
): SchemaResult<ObjectType> {
  const name = cleanName(input.name, "An object type");
  if (state.objectTypes.length >= MAX_OBJECT_TYPES_PER_SPACE) {
    fail(`A space holds at most ${MAX_OBJECT_TYPES_PER_SPACE} object types.`);
  }
  const clash = state.objectTypes.find((type) => sameName(type.name, name));
  if (clash) {
    fail(
      `An object type named "${clash.name}" already exists (id ${clash.id}). Add attributes to it instead of creating a second one.`,
    );
  }
  const taken = new Set(state.objectTypes.map((type) => type.slug));
  const shell: ObjectType = {
    id: ctx.mintId("type"),
    slug: uniqueSlug(slugify(name, "object"), taken),
    name,
    namePlural: input.namePlural?.trim() || `${name}s`,
    icon: input.icon?.trim() || DEFAULT_OBJECT_TYPE_ICON,
    description: input.description?.trim() ?? "",
    attributes: [],
    recordCount: 0,
    createdBy: ctx.actor,
    createdAt: ctx.now().toISOString(),
  };
  const primary: AttributeDefinition = {
    ...baseAttribute(ctx, shell, "Name", "text"),
    slug: PRIMARY_ATTRIBUTE_SLUG,
    isPrimary: true,
    isRequired: true,
  };
  const created: ObjectType = { ...shell, attributes: [primary] };
  return {
    state: { ...state, objectTypes: [...state.objectTypes, created] },
    result: created,
  };
}

export function updateObjectType(
  state: SpaceState,
  typeId: string,
  patch: Partial<ObjectTypeInput>,
): SchemaResult<ObjectType> {
  const type = requireType(state, typeId);
  let next: ObjectType = type;
  if (patch.name !== undefined) {
    const name = cleanName(patch.name, "An object type");
    const clash = state.objectTypes.find(
      (other) => other.id !== typeId && sameName(other.name, name),
    );
    if (clash) fail(`An object type named "${clash.name}" already exists.`);
    // The slug is deliberately left alone: a rename never changes it.
    next = { ...next, name };
  }
  if (patch.namePlural !== undefined) {
    next = { ...next, namePlural: cleanName(patch.namePlural, "The plural") };
  }
  if (patch.icon !== undefined) {
    next = { ...next, icon: patch.icon.trim() || DEFAULT_OBJECT_TYPE_ICON };
  }
  if (patch.description !== undefined) {
    next = { ...next, description: patch.description.trim() };
  }
  return { state: replaceType(state, next), result: next };
}

function assertFlags(input: AttributeInput, name: string) {
  const isMultivalue = input.isMultivalue === true;
  if (input.type === "status" && isMultivalue) {
    fail(`${name}: a status attribute holds exactly one value.`);
  }
  if (isMultivalue && !MULTIVALUE_TYPES.includes(input.type)) {
    fail(
      `${name}: only ${MULTIVALUE_TYPES.join(", ")} attributes can hold multiple values.`,
    );
  }
  if (isMultivalue && input.isUnique === true) {
    fail(`${name}: a unique attribute cannot hold multiple values.`);
  }
  if (input.type === "toggle" && input.isUnique === true) {
    fail(`${name}: a toggle attribute cannot be unique.`);
  }
}

function buildValueAttribute(
  ctx: MockContext,
  type: ObjectType,
  input: AttributeInput,
  name: string,
): AttributeDefinition {
  assertFlags(input, name);
  if (input.relationship) {
    fail(`${name}: only relationship attributes take a relationship target.`);
  }
  let optionNames = cleanOptionNames(input.options);
  if (!OPTION_TYPES.includes(input.type) && optionNames.length > 0) {
    fail(`${name}: options are only valid for select and status attributes.`);
  }
  if (input.type === "select" && optionNames.length === 0) {
    fail(`${name}: a select attribute needs at least one option.`);
  }
  if (input.type === "status" && optionNames.length === 0) {
    optionNames = [...DEFAULT_STATUS_OPTIONS];
  }
  const currencyCode =
    input.type === "currency"
      ? (input.currencyCode ?? DEFAULT_CURRENCY_CODE).trim().toUpperCase()
      : null;
  if (currencyCode !== null && !/^[A-Z]{3}$/.test(currencyCode)) {
    fail(`${name}: "${currencyCode}" is not a three letter currency code.`);
  }
  return {
    ...baseAttribute(ctx, type, name, input.type),
    description: input.description?.trim() ?? "",
    isRequired: input.isRequired === true,
    isUnique: input.isUnique === true,
    isMultivalue: input.isMultivalue === true,
    options: mintOptions(ctx, optionNames, 0),
    currencyCode,
  };
}

export function addAttribute(
  state: SpaceState,
  ctx: MockContext,
  typeId: string,
  input: AttributeInput,
): SchemaResult<AttributeDefinition> {
  const type = requireType(state, typeId);
  const name = cleanName(input.name, "An attribute");
  if (!ATTRIBUTE_TYPES.includes(input.type)) {
    fail(
      `${name}: "${input.type}" is not an attribute type. Valid: ${ATTRIBUTE_TYPES.join(", ")}.`,
    );
  }
  if (type.attributes.length >= MAX_ATTRIBUTES_PER_TYPE) {
    fail(`${type.name} already has ${MAX_ATTRIBUTES_PER_TYPE} attributes.`);
  }
  assertNameFree(type, name);
  if (input.type === "relationship") {
    return addRelationship(state, ctx, type, input, name);
  }
  const attribute = buildValueAttribute(ctx, type, input, name);
  const next = { ...type, attributes: [...type.attributes, attribute] };
  return { state: replaceType(state, next), result: attribute };
}

function patchOptions(
  ctx: MockContext,
  attribute: AttributeDefinition,
  patch: AttributePatch,
): readonly SelectOption[] {
  let { options } = attribute;
  if (patch.addOptions !== undefined) {
    for (const raw of patch.addOptions) {
      const name = cleanName(raw, "An option");
      // An existing name, in any letter case, is a no-op.
      if (options.some((option) => sameName(option.name, name))) continue;
      options = [...options, ...mintOptions(ctx, [name], options.length)];
    }
  }
  if (patch.renameOption !== undefined) {
    const { id } = patch.renameOption;
    const name = cleanName(patch.renameOption.name, "An option");
    if (!options.some((option) => option.id === id)) {
      fail(`${attribute.name} has no option with id "${id}".`, attribute.slug);
    }
    const clash = options.find(
      (option) => option.id !== id && sameName(option.name, name),
    );
    if (clash) {
      fail(
        `${attribute.name} already has an option named "${clash.name}".`,
        attribute.slug,
      );
    }
    // The id is kept, so no record is rewritten by an option rename.
    options = options.map((option) =>
      option.id === id ? { ...option, name } : option,
    );
  }
  return options;
}

/** Type, uniqueness, and multivalue are fixed at creation; so is the slug. */
function assertPatchKeys(patch: AttributePatch) {
  for (const key of Object.keys(patch)) {
    if (IMMUTABLE_ATTRIBUTE_KEYS.includes(key)) {
      fail(`${key} cannot be changed after an attribute is created.`);
    }
    if (!ATTRIBUTE_PATCH_KEYS.includes(key)) {
      fail(
        `"${key}" is not editable. Editable: ${ATTRIBUTE_PATCH_KEYS.join(", ")}.`,
      );
    }
  }
}

function assertRequiredChange(
  attribute: AttributeDefinition,
  isRequired: boolean,
) {
  if (attribute.isPrimary && !isRequired) {
    fail("The primary attribute is always required.", attribute.slug);
  }
  if (attribute.type === "relationship" && isRequired) {
    fail("A relationship attribute cannot be required.", attribute.slug);
  }
}

export function updateAttribute(
  state: SpaceState,
  ctx: MockContext,
  typeId: string,
  attributeId: string,
  patch: AttributePatch,
): SchemaResult<AttributeDefinition> {
  const type = requireType(state, typeId);
  const attribute = type.attributes.find((item) => item.id === attributeId);
  if (!attribute) {
    return fail(`${type.name} has no attribute with id "${attributeId}".`);
  }
  assertPatchKeys(patch);
  let next: AttributeDefinition = attribute;
  if (patch.name !== undefined) {
    const name = cleanName(patch.name, "An attribute");
    assertNameFree(type, name, attribute.id);
    // The slug is deliberately left alone: a rename never changes it.
    next = { ...next, name };
  }
  if (patch.description !== undefined) {
    next = { ...next, description: patch.description.trim() };
  }
  if (patch.isRequired !== undefined) {
    assertRequiredChange(attribute, patch.isRequired);
    next = { ...next, isRequired: patch.isRequired };
  }
  if (patch.addOptions !== undefined || patch.renameOption !== undefined) {
    if (!OPTION_TYPES.includes(attribute.type)) {
      fail(
        `${attribute.name} is a ${attribute.type} attribute and has no options.`,
        attribute.slug,
      );
    }
    next = { ...next, options: patchOptions(ctx, attribute, patch) };
  }
  const nextType = {
    ...type,
    attributes: type.attributes.map((item) =>
      item.id === next.id ? next : item,
    ),
  };
  return { state: replaceType(state, nextType), result: next };
}
