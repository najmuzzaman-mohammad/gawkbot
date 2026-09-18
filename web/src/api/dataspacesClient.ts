/**
 * The live `DataClient`: the broker `/data/spaces/**` routes behind the same
 * interface the mock implements (slice S3 of docs/specs/agent-data-model.md).
 *
 * Two shapes meet here and neither moves. The broker speaks the Go structs in
 * `internal/dataspace/types.go` — snake_case, batch writes answering the
 * `{succeeded, failed, summary, entries[]}` envelope. `dataspaces.ts` speaks
 * camelCase and one object per call. Everything below is that translation and
 * nothing else; no rule lives in this file, because the rules live in the Go
 * store and the mock's tests are their oracle.
 *
 * Errors: `client.ts` raises `ApiError` for every non-2xx. A 400 carries
 * `{error, attribute}` and becomes `DataValidationError(message, attribute)`
 * so a field-level message lands next to its field; 403 and 404 carry a
 * sentence the operator can act on and become `DataValidationError` too,
 * which is what `SpaceLoadError` and the hooks' retry gate already key on. A
 * 429 or a 5xx stays an `ApiError` — those are "try again", not "you typed
 * something wrong".
 *
 * A failed entry inside a 200 envelope is raised the same way: these single-
 * item methods send one item, so one failed entry is the call failing.
 */

import { ApiError, get, patch, post } from "./client";
import type {
  AttributeDefinition,
  AttributeInput,
  AttributePatch,
  AttributeType,
  CallerLevel,
  Cardinality,
  DataClient,
  DataRecord,
  DataSpace,
  DeleteKind,
  DeletePreview,
  FilterClause,
  ObjectType,
  ObjectTypeInput,
  OptionColor,
  RecordPage,
  RecordQuery,
  RecordRef,
  RecordValuesPatch,
  SchemaRelationship,
  SpaceAccess,
  SpaceSchema,
} from "./dataspaces";
import {
  CALLER_LEVELS,
  CARDINALITIES,
  DataValidationError,
  DELETE_KINDS,
  OPTION_COLORS,
} from "./dataspaces";

// ── Wire shapes (exactly the JSON internal/dataspace marshals) ──

interface WireOption {
  id: string;
  name: string;
  /** Not `OptionColor`: a newer store may mint a slot this bundle lacks. */
  color: string;
}

interface WireRelationship {
  relationship_id: string;
  target_type_id: string;
  /** Not `Cardinality`: a newer store may send a value this bundle lacks. */
  cardinality: string;
  inverse_attribute_id?: string;
}

/** One row of `Schema.Relationships`, the server's own view of each pair. */
interface WireSchemaRelationship {
  id: string;
  source_type_id: string;
  source_attribute_id: string;
  target_type_id: string;
  inverse_attribute_id?: string;
  cardinality: string;
}

interface WireAttribute {
  id: string;
  slug: string;
  name: string;
  type: AttributeType;
  description?: string;
  is_primary: boolean;
  is_required: boolean;
  is_unique: boolean;
  is_multivalue: boolean;
  options?: readonly WireOption[];
  currency_code?: string;
  relationship?: WireRelationship;
  created_by: string;
}

interface WireObjectType {
  id: string;
  slug: string;
  name: string;
  name_plural: string;
  icon?: string;
  description?: string;
  attributes?: readonly WireAttribute[];
  record_count: number;
  created_by: string;
  created_at: string;
}

interface WireSpace {
  id: string;
  name: string;
  description?: string;
  owner: string;
  access: SpaceAccess;
  object_type_count: number;
  record_count: number;
  attached_app_ids?: readonly string[];
  created_at: string;
  updated_at: string;
  caller_level?: string;
}

interface WireRecordRef {
  id: string;
  type_id: string;
  name: string;
}

interface WireRecord {
  id: string;
  type_id: string;
  values?: Record<string, DataRecord["values"][string]>;
  links?: Record<string, readonly WireRecordRef[]>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface WireEntry {
  index: number;
  identifier?: string;
  status: "ok" | "noop" | "failed";
  error?: string;
  attribute?: string;
  id?: string;
}

interface WireResult {
  succeeded: number;
  failed: number;
  summary: string;
  entries?: readonly WireEntry[];
}

// ── Narrowing ──

/**
 * The store is the authority on these closed sets and it can ship a value
 * before this bundle does, so every one of them is narrowed on arrival rather
 * than asserted through. A cast would put an unmodelled string behind a type
 * that promises it cannot be there, and the first component to index a lookup
 * table with it renders `undefined` and unmounts its subtree.
 */
function narrow<T extends string>(
  known: readonly T[],
  value: string | undefined,
  fallback: T,
): T {
  const match = known.find((candidate) => candidate === value);
  return match ?? fallback;
}

/** An unrecognised slot renders as the neutral one, never as nothing. */
function toOptionColor(color: string | undefined): OptionColor {
  return narrow(OPTION_COLORS, color, "neutral");
}

/**
 * `many_to_many` is the only safe fallback: it is the one shape that claims
 * no limit, so an unrecognised cardinality never has the UI tell an operator
 * a link is to-one when the store would happily accept a second one.
 */
function toCardinality(cardinality: string | undefined): Cardinality {
  return narrow(CARDINALITIES, cardinality, "many_to_many");
}

/**
 * Missing means an older broker that does not send it. The operator always
 * has write access, so assuming write is right for the surface this client
 * serves; the store still refuses anything the caller may not do.
 */
function toCallerLevel(level: string | undefined): CallerLevel {
  return narrow(CALLER_LEVELS, level, "write");
}

// ── Mapping ──

function mapOption(option: WireOption): {
  id: string;
  name: string;
  color: OptionColor;
} {
  return {
    id: option.id,
    name: option.name,
    color: toOptionColor(option.color),
  };
}

function mapAttribute(attribute: WireAttribute): AttributeDefinition {
  return {
    id: attribute.id,
    slug: attribute.slug,
    name: attribute.name,
    type: attribute.type,
    description: attribute.description ?? "",
    isPrimary: attribute.is_primary,
    isRequired: attribute.is_required,
    isUnique: attribute.is_unique,
    isMultivalue: attribute.is_multivalue,
    options: (attribute.options ?? []).map(mapOption),
    currencyCode: attribute.currency_code ?? null,
    relationship: attribute.relationship
      ? {
          relationshipId: attribute.relationship.relationship_id,
          targetTypeId: attribute.relationship.target_type_id,
          cardinality: toCardinality(attribute.relationship.cardinality),
          inverseAttributeId:
            attribute.relationship.inverse_attribute_id ?? null,
        }
      : null,
    createdBy: attribute.created_by,
  };
}

function mapObjectType(objectType: WireObjectType): ObjectType {
  return {
    id: objectType.id,
    slug: objectType.slug,
    name: objectType.name,
    namePlural: objectType.name_plural,
    icon: objectType.icon ?? "",
    description: objectType.description ?? "",
    attributes: (objectType.attributes ?? []).map(mapAttribute),
    recordCount: objectType.record_count,
    createdBy: objectType.created_by,
    createdAt: objectType.created_at,
  };
}

function mapSpace(space: WireSpace): DataSpace {
  return {
    id: space.id,
    name: space.name,
    description: space.description ?? "",
    owner: space.owner,
    access: space.access,
    objectTypeCount: space.object_type_count,
    recordCount: space.record_count,
    attachedAppIds: space.attached_app_ids ?? [],
    createdAt: space.created_at,
    updatedAt: space.updated_at,
    callerLevel: toCallerLevel(space.caller_level),
  };
}

function mapSchemaRelationship(
  relationship: WireSchemaRelationship,
): SchemaRelationship {
  return {
    id: relationship.id,
    sourceTypeId: relationship.source_type_id,
    sourceAttributeId: relationship.source_attribute_id,
    targetTypeId: relationship.target_type_id,
    inverseAttributeId: relationship.inverse_attribute_id ?? null,
    cardinality: toCardinality(relationship.cardinality),
  };
}

function mapRecordRef(ref: WireRecordRef): RecordRef {
  return { id: ref.id, typeId: ref.type_id, name: ref.name };
}

function mapRecord(record: WireRecord): DataRecord {
  const links: Record<string, readonly RecordRef[]> = {};
  for (const [slug, refs] of Object.entries(record.links ?? {})) {
    links[slug] = refs.map(mapRecordRef);
  }
  return {
    id: record.id,
    typeId: record.type_id,
    values: record.values ?? {},
    links,
    createdBy: record.created_by,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

/** `AttributeInput` on the wire. Options are names; the store mints their ids. */
function attributeInputBody(input: AttributeInput): Record<string, unknown> {
  return {
    name: input.name,
    type: input.type,
    description: input.description,
    is_required: input.isRequired,
    is_unique: input.isUnique,
    is_multivalue: input.isMultivalue,
    options: input.options,
    currency_code: input.currencyCode,
    relationship: input.relationship
      ? {
          target: input.relationship.targetTypeId,
          cardinality: input.relationship.cardinality,
          inverse_name: input.relationship.inverseName,
        }
      : undefined,
  };
}

function filterBody(filter: FilterClause): Record<string, unknown> {
  return {
    attribute: filter.attribute,
    operator: filter.operator,
    value: filter.value,
  };
}

// ── Errors ──

/**
 * `ApiError` -> `DataValidationError` for the statuses that mean "the request
 * was answerable and the answer is no". Anything else is left alone so the
 * hooks' retry gate and the generic error surfaces still see it.
 */
function translateError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status !== 400 && error.status !== 403 && error.status !== 404) {
    return error;
  }
  const body = parseErrorBody(error.bodyText);
  // A non-JSON body leaves ApiError's own humanized message in place.
  const message = body.error?.trim() ? body.error : error.message;
  return new DataValidationError(message, body.attribute || null);
}

/** The `{error, attribute}` envelope the /data routes answer 400 with. */
function parseErrorBody(bodyText: string): {
  error?: string;
  attribute?: string;
} {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null) return {};
    const { error, attribute } = parsed as Readonly<Record<string, unknown>>;
    return {
      error: typeof error === "string" ? error : undefined,
      attribute: typeof attribute === "string" ? attribute : undefined,
    };
  } catch {
    return {};
  }
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translateError(error);
  }
}

/**
 * Unwrap a single-item batch. A `failed` entry is the call failing, and its
 * `attribute` is what puts the message next to the right field.
 */
function unwrapEntry(result: WireResult): WireEntry {
  const entry = result.entries?.[0];
  if (!entry) {
    throw new DataValidationError(
      result.summary || "The write returned no result.",
    );
  }
  if (entry.status === "failed") {
    throw new DataValidationError(
      entry.error || result.summary || "The write failed.",
      entry.attribute ?? null,
    );
  }
  return entry;
}

function unwrapEntryId(result: WireResult): string {
  const entry = unwrapEntry(result);
  if (!entry.id) {
    throw new DataValidationError(
      result.summary || "The write returned no id.",
    );
  }
  return entry.id;
}

// ── Client ──

function spacePath(spaceId: string): string {
  return `/data/spaces/${encodeURIComponent(spaceId)}`;
}

export function createBrokerDataClient(): DataClient {
  const schema = (spaceId: string): Promise<SpaceSchema> =>
    call(async () => {
      const wire = await get<{
        space: WireSpace;
        object_types?: readonly WireObjectType[];
        relationships?: readonly WireSchemaRelationship[];
      }>(spacePath(spaceId));
      return {
        space: mapSpace(wire.space),
        objectTypes: (wire.object_types ?? []).map(mapObjectType),
        // Left undefined, not defaulted to empty: "this broker does not send
        // the list" and "this space has no relationships" are different
        // answers, and only the first one may fall back to inference.
        relationships: wire.relationships?.map(mapSchemaRelationship),
      };
    });

  const record = (spaceId: string, recordId: string): Promise<DataRecord> =>
    call(async () => {
      const wire = await get<{ record: WireRecord }>(
        `${spacePath(spaceId)}/records/${encodeURIComponent(recordId)}`,
      );
      return mapRecord(wire.record);
    });

  /** Re-read the type after a write that answers only the batch envelope. */
  const objectTypeById = async (
    spaceId: string,
    typeId: string,
  ): Promise<ObjectType> => {
    const next = await schema(spaceId);
    const found = next.objectTypes.find((candidate) => candidate.id === typeId);
    if (!found) {
      throw new DataValidationError(
        `Object type "${typeId}" is not in this data space.`,
      );
    }
    return found;
  };

  return {
    listSpaces: () =>
      call(async () => {
        const wire = await get<{ spaces?: readonly WireSpace[] }>(
          "/data/spaces",
        );
        return (wire.spaces ?? []).map(mapSpace);
      }),

    getSchema: schema,

    updateSpaceAccess: (spaceId, access: SpaceAccess) =>
      call(async () => {
        const wire = await patch<{ space: WireSpace }>(spacePath(spaceId), {
          access,
        });
        return mapSpace(wire.space);
      }),

    createObjectType: (spaceId, input: ObjectTypeInput) =>
      call(async () => {
        const result = await post<WireResult>(
          `${spacePath(spaceId)}/object-types`,
          {
            items: [
              {
                name: input.name,
                name_plural: input.namePlural,
                icon: input.icon,
                description: input.description,
              },
            ],
          },
        );
        return objectTypeById(spaceId, unwrapEntryId(result));
      }),

    updateObjectType: (spaceId, typeId, typePatch) =>
      call(async () => {
        const wire = await patch<{ object_type: WireObjectType }>(
          `${spacePath(spaceId)}/object-types/${encodeURIComponent(typeId)}`,
          {
            name: typePatch.name,
            name_plural: typePatch.namePlural,
            icon: typePatch.icon,
            description: typePatch.description,
          },
        );
        return mapObjectType(wire.object_type);
      }),

    addAttribute: (spaceId, typeId, input) =>
      call(async () => {
        const result = await post<WireResult>(
          `${spacePath(spaceId)}/object-types/${encodeURIComponent(typeId)}/attributes`,
          { items: [attributeInputBody(input)] },
        );
        const attributeId = unwrapEntryId(result);
        const objectType = await objectTypeById(spaceId, typeId);
        const found = objectType.attributes.find(
          (candidate) => candidate.id === attributeId,
        );
        if (!found) {
          throw new DataValidationError(
            `Attribute "${attributeId}" is not on ${objectType.name}.`,
          );
        }
        return found;
      }),

    updateAttribute: (
      spaceId,
      typeId,
      attributeId,
      attributePatch: AttributePatch,
    ) =>
      call(async () => {
        const wire = await patch<{ attribute: WireAttribute }>(
          `${spacePath(spaceId)}/object-types/${encodeURIComponent(typeId)}/attributes/${encodeURIComponent(attributeId)}`,
          {
            name: attributePatch.name,
            description: attributePatch.description,
            is_required: attributePatch.isRequired,
            add_options: attributePatch.addOptions,
            rename_option: attributePatch.renameOption,
          },
        );
        return mapAttribute(wire.attribute);
      }),

    queryRecords: (spaceId, query: RecordQuery): Promise<RecordPage> =>
      call(async () => {
        const wire = await post<{
          records?: readonly WireRecord[];
          total: number;
        }>(`${spacePath(spaceId)}/records/query`, {
          object_type: query.typeId,
          filters: query.filters?.map(filterBody),
          sort: query.sort
            ? {
                attribute: query.sort.attribute,
                desc: query.sort.direction === "desc",
              }
            : undefined,
          query: query.query,
          limit: query.limit,
          offset: query.offset,
        });
        return {
          records: (wire.records ?? []).map(mapRecord),
          total: wire.total,
        };
      }),

    getRecord: record,

    createRecord: (spaceId, typeId, values: RecordValuesPatch) =>
      call(async () => {
        const result = await post<WireResult>(`${spacePath(spaceId)}/records`, {
          object_type: typeId,
          items: [{ values }],
        });
        return record(spaceId, unwrapEntryId(result));
      }),

    updateRecord: (spaceId, recordId, values: RecordValuesPatch) =>
      call(async () => {
        const wire = await patch<{ record: WireRecord }>(
          `${spacePath(spaceId)}/records/${encodeURIComponent(recordId)}`,
          { values },
        );
        return mapRecord(wire.record);
      }),

    linkRecords: (spaceId, recordId, attributeSlug, targetId, replace) =>
      call(async () => {
        const result = await post<WireResult>(`${spacePath(spaceId)}/links`, {
          items: [
            {
              record: recordId,
              attribute: attributeSlug,
              target: targetId,
              replace: replace ?? false,
            },
          ],
        });
        unwrapEntry(result);
        return record(spaceId, recordId);
      }),

    unlinkRecords: (spaceId, recordId, attributeSlug, targetId) =>
      call(async () => {
        const result = await post<WireResult>(`${spacePath(spaceId)}/unlinks`, {
          items: [
            { record: recordId, attribute: attributeSlug, target: targetId },
          ],
        });
        unwrapEntry(result);
        return record(spaceId, recordId);
      }),

    previewDelete: (spaceId, kind: DeleteKind, ids) =>
      call(async () => {
        const wire = await post<{
          token: string;
          kind: string;
          impact: DeletePreview["impact"];
        }>(`${spacePath(spaceId)}/delete-preview`, { kind, ids });
        return {
          token: wire.token,
          // The kind we asked for is the honest fallback: the token is bound
          // to this request, whatever the store called it back.
          kind: narrow(DELETE_KINDS, wire.kind, kind),
          impact: wire.impact,
        };
      }),

    executeDelete: (spaceId, token) =>
      call(async () => {
        await post(`${spacePath(spaceId)}/delete`, { token });
      }),
  };
}

/**
 * THE MODULE SWAP, kept explicit on purpose.
 *
 * This export used to be `createMockDataClient()`. It is now the broker-backed
 * client, so the Data section talks to the real store.
 *
 * The mock has not gone anywhere and is still the client the component tests
 * and the stories build on. They import `createMockDataClient` from
 * `./dataspaces.mock` and replace THIS module wholesale
 * (`vi.mock("…/dataspacesClient", …)`), so none of their setup changes and
 * none of them reach the network. `createBrokerDataClient` is exported for the
 * same reason in reverse: a test that wants the real client with a mocked
 * `client.ts` underneath can build one without importing this singleton.
 */
export const dataClient: DataClient = createBrokerDataClient();
