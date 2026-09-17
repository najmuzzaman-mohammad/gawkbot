/**
 * Data spaces: bot-owned structured datastores. A bot defines object types,
 * attributes, and relationships on the fly, then fills them with records.
 * One space per use case; built apps attach to a space and use its records.
 *
 * Spec: docs/specs/agent-data-model.md. The wire shape here mirrors the
 * broker `/data/spaces/**` routes 1:1. The live client instance is exported
 * from `dataspacesClient.ts`.
 */

export const ATTRIBUTE_TYPES = [
  "text",
  "number",
  "currency",
  "date",
  "toggle",
  "select",
  "status",
  "rating",
  "url",
  "email",
  "phone",
  "relationship",
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** Cardinality is always stated from the side that owns the attribute. */
export const CARDINALITIES = [
  "one_to_one",
  "many_to_one",
  "one_to_many",
  "many_to_many",
] as const;
export type Cardinality = (typeof CARDINALITIES)[number];

/** Option colors are semantic slots resolved to theme tokens in CSS. */
export const OPTION_COLORS = [
  "neutral",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export interface SelectOption {
  /** Minted by the server. Renaming an option keeps its id. */
  id: string;
  name: string;
  color: OptionColor;
}

export interface RelationshipRef {
  relationshipId: string;
  targetTypeId: string;
  cardinality: Cardinality;
  /** The mirrored attribute on the target type, when one was created. */
  inverseAttributeId: string | null;
}

export interface AttributeDefinition {
  id: string;
  /** Stable for the life of the attribute. A rename never changes it. */
  slug: string;
  name: string;
  type: AttributeType;
  description: string;
  /** The record's display name. Exactly one per object type. */
  isPrimary: boolean;
  isRequired: boolean;
  isUnique: boolean;
  isMultivalue: boolean;
  /** Populated for `select` and `status`; empty otherwise. */
  options: readonly SelectOption[];
  /** ISO 4217 code for `currency` attributes. */
  currencyCode: string | null;
  relationship: RelationshipRef | null;
  /** Bot slug, or "human" for the operator. */
  createdBy: string;
}

export interface ObjectType {
  id: string;
  slug: string;
  name: string;
  namePlural: string;
  /** iconoir-react icon key resolved by `objectTypeIcon`. */
  icon: string;
  description: string;
  attributes: readonly AttributeDefinition[];
  recordCount: number;
  createdBy: string;
  createdAt: string;
}

/**
 * Who besides the operator can use a space. `private`: the owning bot only.
 * `shared`: the owner plus the bots in `grants`. `global`: every bot in the
 * office reads and writes, present and future.
 */
export const SPACE_SCOPES = ["private", "shared", "global"] as const;
export type SpaceScope = (typeof SPACE_SCOPES)[number];

export const ACCESS_LEVELS = ["read", "write"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface SpaceGrant {
  /** Bot slug. Never the owner; the owner always has write. */
  bot: string;
  level: AccessLevel;
}

export interface SpaceAccess {
  scope: SpaceScope;
  /** Non-empty only when `scope` is `shared`. Sorted by bot slug. */
  grants: readonly SpaceGrant[];
}

export interface DataSpace {
  id: string;
  name: string;
  description: string;
  /**
   * Bot slug that created the space. Kept for provenance when a space goes
   * global; the owner always has write access.
   */
  owner: string;
  access: SpaceAccess;
  objectTypeCount: number;
  recordCount: number;
  /** App ids (app_<16hex>) attached to this space. */
  attachedAppIds: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface SpaceSchema {
  space: DataSpace;
  objectTypes: readonly ObjectType[];
}

/**
 * Stored value by attribute type:
 * text/url/email/phone -> string; number/currency/rating -> number;
 * date -> "YYYY-MM-DD"; toggle -> boolean; select/status -> option id, or an
 * array of option ids when multivalue. Relationship attributes carry no
 * value; their links live in `DataRecord.links`.
 */
export type AttributeValue = string | number | boolean | readonly string[];

export interface RecordRef {
  id: string;
  typeId: string;
  name: string;
}

export interface DataRecord {
  id: string;
  typeId: string;
  /** Keyed by attribute slug. A missing key means "empty". */
  values: Readonly<Record<string, AttributeValue>>;
  /** Keyed by relationship attribute slug. */
  links: Readonly<Record<string, readonly RecordRef[]>>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const FILTER_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "greater",
  "less",
  "is_empty",
  "is_not_empty",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FilterClause {
  attribute: string;
  operator: FilterOperator;
  value?: string;
}

export type SortDirection = "asc" | "desc";

export interface RecordQuery {
  typeId: string;
  filters?: readonly FilterClause[];
  sort?: { attribute: string; direction: SortDirection };
  query?: string;
  limit: number;
  offset: number;
}

export interface RecordPage {
  records: readonly DataRecord[];
  total: number;
}

export interface RelationshipInput {
  targetTypeId: string;
  cardinality: Cardinality;
  /** Empty string skips the mirrored attribute on the target type. */
  inverseName: string;
}

export interface AttributeInput {
  name: string;
  type: AttributeType;
  description?: string;
  isRequired?: boolean;
  isUnique?: boolean;
  isMultivalue?: boolean;
  /** Option names for `select` / `status`. */
  options?: readonly string[];
  currencyCode?: string;
  relationship?: RelationshipInput;
}

export interface ObjectTypeInput {
  name: string;
  namePlural?: string;
  icon?: string;
  description?: string;
}

export interface AttributePatch {
  name?: string;
  description?: string;
  isRequired?: boolean;
  /** Append-only by name; an existing name is a no-op. */
  addOptions?: readonly string[];
  renameOption?: { id: string; name: string };
}

export type DeleteKind = "space" | "object_type" | "attribute" | "records";

export interface DeleteImpact {
  records: number;
  links: number;
  attributes: number;
  objectTypes: number;
}

export interface DeletePreview {
  /** Bound to the exact id set; expires after 15 minutes. */
  token: string;
  kind: DeleteKind;
  impact: DeleteImpact;
}

/** `null` clears a value. */
export type RecordValuesPatch = Readonly<Record<string, AttributeValue | null>>;

export interface DataClient {
  listSpaces(): Promise<readonly DataSpace[]>;
  getSchema(spaceId: string): Promise<SpaceSchema>;
  /**
   * Replace a space's sharing. Leaving `shared` drops its grants; `shared`
   * with no grants is stored as `private`.
   */
  updateSpaceAccess(spaceId: string, access: SpaceAccess): Promise<DataSpace>;
  createObjectType(
    spaceId: string,
    input: ObjectTypeInput,
  ): Promise<ObjectType>;
  updateObjectType(
    spaceId: string,
    typeId: string,
    patch: Partial<ObjectTypeInput>,
  ): Promise<ObjectType>;
  addAttribute(
    spaceId: string,
    typeId: string,
    input: AttributeInput,
  ): Promise<AttributeDefinition>;
  updateAttribute(
    spaceId: string,
    typeId: string,
    attributeId: string,
    patch: AttributePatch,
  ): Promise<AttributeDefinition>;
  queryRecords(spaceId: string, query: RecordQuery): Promise<RecordPage>;
  getRecord(spaceId: string, recordId: string): Promise<DataRecord>;
  createRecord(
    spaceId: string,
    typeId: string,
    values: RecordValuesPatch,
  ): Promise<DataRecord>;
  updateRecord(
    spaceId: string,
    recordId: string,
    values: RecordValuesPatch,
  ): Promise<DataRecord>;
  /** `replace` swaps a conflicting to-one link instead of failing. */
  linkRecords(
    spaceId: string,
    recordId: string,
    attributeSlug: string,
    targetId: string,
    replace?: boolean,
  ): Promise<DataRecord>;
  unlinkRecords(
    spaceId: string,
    recordId: string,
    attributeSlug: string,
    targetId: string,
  ): Promise<DataRecord>;
  previewDelete(
    spaceId: string,
    kind: DeleteKind,
    ids: readonly string[],
  ): Promise<DeletePreview>;
  executeDelete(spaceId: string, token: string): Promise<void>;
}

/** Thrown by the client with a message a human or a bot can act on. */
export class DataValidationError extends Error {
  readonly attribute: string | null;

  constructor(message: string, attribute: string | null = null) {
    super(message);
    this.name = "DataValidationError";
    this.attribute = attribute;
  }
}

export const DEFAULT_PAGE_SIZE = 30;
export const PAGE_SIZE_OPTIONS = [10, 30, 50, 100] as const;
