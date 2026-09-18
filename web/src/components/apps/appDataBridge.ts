// appDataBridge — the host half of the app bridge's `data.*` API: the DATA
// SPACE attached to an app (object types, attributes, relationships, records).
//
// It is the exact shape of the `db` case in CustomAppFrame.tsx — validate the
// inbound message into a host-trusted arg union, then forward ONE sanctioned
// request per op — and lives beside it only because CustomAppFrame.tsx is
// already well past the repo's file-size budget. CustomAppFrame still owns the
// routing and the reply envelope; nothing here touches postMessage.
//
// ── THE SCOPING RULE (the whole security boundary) ──────────────────────────
//
// An app frame may only ever reach the ONE space its OWN manifest names.
//
//   - parseDataArgs NEVER reads a space from the message. There is no space
//     field in DataCallArgs, so a hostile app posting {space:"space_other"} is
//     not rejected so much as unheard: the field has nowhere to go.
//   - resolveAppDataSpace asks the broker for the space bound to THIS app id
//     (which the host supplies; the sealed iframe never sees it).
//   - dispatchDataCall builds the URL from that resolved id alone.
//
// An app with no space attached gets an honest rejection from every call, never
// a silent empty result — a board rendering "no investors" when the truth is
// "this app was never attached to the investor space" is the fabricated-state
// class of bug the honesty pass removed.

import { get, patch, post, put } from "../../api/client";

// Reject-don't-truncate caps. A sliced record id or attribute slug would
// address the WRONG record, so an oversized reference fails the whole call.
const DATA_REF_MAX = 200;
const DATA_TEXT_MAX = 500;
const DATA_FILTERS_MAX = 10;
const DATA_COUNT_MAX = 1000;
// Serialized values/rows byte-ish proxy. The store re-enforces the real
// per-call limits; this is the first cheap gate.
const DATA_VALUES_MAX = 512 * 1024;

/** The message the app posts for a `data.*` call. */
export interface AppDataMessage {
  source: "wuphf-app";
  type: "data";
  id: string | number;
  op?: unknown;
  objectType?: unknown;
  matchingAttribute?: unknown;
  recordId?: unknown;
  attribute?: unknown;
  targetId?: unknown;
  replace?: unknown;
  values?: unknown;
  rows?: unknown;
  filters?: unknown;
  sort?: unknown;
  search?: unknown;
  limit?: unknown;
  offset?: unknown;
}

/** One validated filter clause. Operators are checked by the store. */
export interface DataFilterArg {
  attribute: string;
  operator: string;
  value?: string;
}

/** One validated sort clause. */
export interface DataSortArg {
  attribute: string;
  desc: boolean;
}

/**
 * The host-trusted shape of a data call. Note what is absent: a space. The
 * space is resolved from the app's manifest, never from the app.
 */
export type DataCallArgs =
  | { op: "schema" }
  | {
      op: "query";
      objectType: string;
      filters: readonly DataFilterArg[];
      sort: DataSortArg | null;
      search: string;
      limit: number;
      offset: number;
    }
  | { op: "create"; objectType: string; values: Record<string, unknown> }
  | {
      op: "upsert";
      objectType: string;
      matchingAttribute: string;
      rows: readonly Record<string, unknown>[];
    }
  | { op: "update"; recordId: string; values: Record<string, unknown> }
  | {
      op: "link";
      recordId: string;
      attribute: string;
      targetId: string;
      replace: boolean;
    }
  | { op: "unlink"; recordId: string; attribute: string; targetId: string };

/** The one message an app sees when nothing is attached. Never an empty page. */
export const NO_DATA_SPACE_ERROR = "This app has no data space attached.";

/** The rejection for a malformed call, naming what a valid one looks like. */
export const BAD_DATA_CALL_ERROR =
  "A data call needs op ∈ {schema,query,create,upsert,update,link,unlink} and that op's own fields.";

/** A slug, id, or attribute reference: trimmed, non-empty, within the cap. */
function dataRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  if (!ref || ref.length > DATA_REF_MAX) return null;
  return ref;
}

/** A plain object of attribute values within the serialized size cap. */
function dataValues(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (JSON.stringify(value).length > DATA_VALUES_MAX) return null;
  } catch {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * An array of plain-object rows. A malformed row fails the WHOLE call rather
 * than being dropped: silently writing 9 of the 10 rows an app asked for is
 * data loss the app would never learn about.
 */
function dataRows(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (JSON.stringify(value).length > DATA_VALUES_MAX) return null;
  } catch {
    return null;
  }
  const rows = value.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === "object" && !Array.isArray(row),
  );
  return rows.length === value.length ? rows : null;
}

/** Filter clauses, or null when any one of them is unusable. */
function dataFilters(value: unknown): DataFilterArg[] | null {
  if (!Array.isArray(value) || value.length > DATA_FILTERS_MAX) return null;
  const filters: DataFilterArg[] = [];
  for (const raw of value) {
    const clause = (raw ?? {}) as Record<string, unknown>;
    const attribute = dataRef(clause.attribute);
    const operator = dataRef(clause.operator);
    if (!(attribute && operator)) return null;
    if (clause.value === undefined || clause.value === null) {
      filters.push({ attribute, operator });
      continue;
    }
    if (
      typeof clause.value !== "string" ||
      clause.value.length > DATA_TEXT_MAX
    ) {
      return null;
    }
    filters.push({ attribute, operator, value: clause.value });
  }
  return filters;
}

/** A sort clause, or null when it is present but unusable. */
function dataSort(value: unknown): DataSortArg | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const attribute = dataRef(raw.attribute);
  if (!attribute) return null;
  return { attribute, desc: raw.desc === true };
}

/** A non-negative count within the cap. -1 marks "present but unusable". */
function dataCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return -1;
  }
  const n = Math.floor(value);
  return n > DATA_COUNT_MAX ? -1 : n;
}

function parseDataQuery(d: Record<string, unknown>): DataCallArgs | null {
  const objectType = dataRef(d.objectType);
  if (!objectType) return null;
  const filters =
    d.filters === undefined || d.filters === null ? [] : dataFilters(d.filters);
  if (!filters) return null;
  const sort =
    d.sort === undefined || d.sort === null ? null : dataSort(d.sort);
  if (d.sort !== undefined && d.sort !== null && !sort) return null;
  const search = typeof d.search === "string" ? d.search.trim() : "";
  if (search.length > DATA_TEXT_MAX) return null;
  const limit = dataCount(d.limit);
  const offset = dataCount(d.offset);
  if (limit < 0 || offset < 0) return null;
  return { op: "query", objectType, filters, sort, search, limit, offset };
}

function parseDataCreate(d: Record<string, unknown>): DataCallArgs | null {
  const objectType = dataRef(d.objectType);
  const values = dataValues(d.values);
  if (!(objectType && values)) return null;
  return { op: "create", objectType, values };
}

function parseDataUpsert(d: Record<string, unknown>): DataCallArgs | null {
  const objectType = dataRef(d.objectType);
  const matchingAttribute = dataRef(d.matchingAttribute);
  const rows = dataRows(d.rows);
  if (!(objectType && matchingAttribute && rows)) return null;
  return { op: "upsert", objectType, matchingAttribute, rows };
}

function parseDataUpdate(d: Record<string, unknown>): DataCallArgs | null {
  const recordId = dataRef(d.recordId);
  const values = dataValues(d.values);
  if (!(recordId && values)) return null;
  return { op: "update", recordId, values };
}

function parseDataLink(
  d: Record<string, unknown>,
  link: boolean,
): DataCallArgs | null {
  const recordId = dataRef(d.recordId);
  const attribute = dataRef(d.attribute);
  const targetId = dataRef(d.targetId);
  if (!(recordId && attribute && targetId)) return null;
  return link
    ? { op: "link", recordId, attribute, targetId, replace: d.replace === true }
    : { op: "unlink", recordId, attribute, targetId };
}

/**
 * The op allowlist IS this table: an op with no parser here cannot be called,
 * and each parser owns only its own op's fields.
 */
const DATA_PARSERS: Record<
  string,
  (d: Record<string, unknown>) => DataCallArgs | null
> = {
  schema: () => ({ op: "schema" }),
  query: parseDataQuery,
  create: parseDataCreate,
  upsert: parseDataUpsert,
  update: parseDataUpdate,
  link: (d) => parseDataLink(d, true),
  unlink: (d) => parseDataLink(d, false),
};

/**
 * Validate + normalize an inbound "data" message into DataCallArgs. Pure, so
 * the rules above are unit-testable without a frame. Returns null when the op
 * is unknown or that op's own fields are missing, malformed, or oversized. The
 * store re-enforces every real rule (slugs, option names, cardinality, access);
 * this is the cheap first gate and the place the space CANNOT enter.
 */
export function parseDataArgs(message: unknown): DataCallArgs | null {
  if (!message || typeof message !== "object") return null;
  const d = message as Record<string, unknown>;
  const op = typeof d.op === "string" ? d.op.trim() : "";
  // hasOwn, not a bare lookup: `op: "constructor"` would otherwise resolve to
  // an inherited function and be called with the message.
  if (!Object.hasOwn(DATA_PARSERS, op)) return null;
  return DATA_PARSERS[op](d);
}

// One in-flight lookup per app, so a burst of data.* calls costs a single GET.
// Nothing is cached ACROSS calls on purpose: attaching or detaching a space
// then takes effect on the very next call instead of after a page reload, and
// a detached app can never keep writing to the space it just left.
const dataSpaceLookups = new Map<string, Promise<string>>();

/**
 * Resolve the space bound to this app from its manifest. This is the only
 * source of a space id on the host side — see the scoping note at the top.
 * Resolves to "" when nothing is attached.
 */
export function resolveAppDataSpace(appId: string): Promise<string> {
  const inflight = dataSpaceLookups.get(appId);
  if (inflight) return inflight;
  const lookup = get<{ space_id?: unknown }>(
    `/apps/${encodeURIComponent(appId)}/data-space`,
  )
    .then((res) =>
      typeof res?.space_id === "string" ? res.space_id.trim() : "",
    )
    .finally(() => {
      dataSpaceLookups.delete(appId);
    });
  dataSpaceLookups.set(appId, lookup);
  return lookup;
}

/**
 * Forward one validated call to the `/data/spaces/{space}/**` routes. `spaceId`
 * is the manifest-resolved id and nothing else ever reaches this URL.
 */
export function dispatchDataCall(
  spaceId: string,
  args: DataCallArgs,
): Promise<unknown> {
  const base = `/data/spaces/${encodeURIComponent(spaceId)}`;
  switch (args.op) {
    case "schema":
      return get(base);
    case "query":
      return post(`${base}/records/query`, {
        object_type: args.objectType,
        ...(args.filters.length > 0 ? { filters: args.filters } : {}),
        ...(args.sort ? { sort: args.sort } : {}),
        ...(args.search ? { query: args.search } : {}),
        ...(args.limit > 0 ? { limit: args.limit } : {}),
        ...(args.offset > 0 ? { offset: args.offset } : {}),
      });
    case "create":
      return post(`${base}/records`, {
        object_type: args.objectType,
        items: [{ values: args.values }],
      });
    case "upsert":
      return put(`${base}/records`, {
        object_type: args.objectType,
        matching_attribute: args.matchingAttribute,
        items: args.rows.map((values) => ({ values })),
      });
    case "update":
      return patch(`${base}/records/${encodeURIComponent(args.recordId)}`, {
        values: args.values,
      });
    case "link":
      return post(`${base}/links`, {
        items: [
          {
            record: args.recordId,
            attribute: args.attribute,
            target: args.targetId,
            replace: args.replace,
          },
        ],
      });
    default:
      return post(`${base}/unlinks`, {
        items: [
          {
            record: args.recordId,
            attribute: args.attribute,
            target: args.targetId,
          },
        ],
      });
  }
}
