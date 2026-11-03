/**
 * Attribute building blocks shared by the schema and relationship operations
 * of the in-memory data client.
 */

import type {
  AttributeDefinition,
  AttributeType,
  ObjectType,
} from "./dataspaces";
import {
  fail,
  type MockContext,
  type SpaceState,
  sameName,
  slugify,
  uniqueSlug,
} from "./dataspaces.mock.store";

export interface SchemaResult<T> {
  state: SpaceState;
  result: T;
}

export function cleanName(raw: unknown, what: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fail(`${what} needs a name.`);
  }
  return raw.trim();
}

export function baseAttribute(
  ctx: MockContext,
  type: ObjectType,
  name: string,
  attributeType: AttributeType,
): AttributeDefinition {
  const taken = new Set(type.attributes.map((attribute) => attribute.slug));
  return {
    id: ctx.mintId("attr"),
    slug: uniqueSlug(slugify(name, "field"), taken),
    name,
    type: attributeType,
    description: "",
    isPrimary: false,
    isRequired: false,
    isUnique: false,
    isMultivalue: false,
    options: [],
    currencyCode: null,
    relationship: null,
    createdBy: ctx.actor,
  };
}

export function assertNameFree(
  type: ObjectType,
  name: string,
  exceptId?: string,
) {
  const clash = type.attributes.find(
    (attribute) => attribute.id !== exceptId && sameName(attribute.name, name),
  );
  if (clash) {
    fail(
      `${type.name} already has an attribute named "${clash.name}" (slug ${clash.slug}). Reuse it instead of adding a duplicate.`,
    );
  }
}
