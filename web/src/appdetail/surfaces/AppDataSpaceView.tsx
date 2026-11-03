// AppDataSpaceView — the Data tab when a DATA SPACE is attached to the app.
//
// A data space is office data, not app data: the operator browses and edits the
// same records under Data, other bots write them, and this app is one more
// reader. So this tab does NOT try to be a second editor. It names the space,
// shows what is in it, and hands the operator a link to the real thing. The
// per-app table view (AppDataTab) stays exactly as it was for every app with no
// space attached.
//
// Split in two on purpose: AppDataSpaceView is pure and story-covered, and
// AppDataSpacePanel is the thin fetching wrapper around it.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { get, post } from "../../api/client";
import { EmptyState } from "../components/EmptyState";
import { Eyebrow } from "../components/primitives";

/** One attribute of an object type, as far as this read-only view cares. */
export interface SpaceAttributeSummary {
  slug: string;
  name: string;
  type: string;
}

/** One object type in the space, with its record count. */
export interface SpaceObjectTypeSummary {
  slug: string;
  name: string;
  namePlural: string;
  recordCount: number;
  attributes: readonly SpaceAttributeSummary[];
}

/** One record, already formatted to display strings keyed by attribute slug. */
export interface SpaceRecordRow {
  id: string;
  values: Record<string, string>;
}

export interface AppDataSpaceViewProps {
  spaceId: string;
  spaceName: string;
  /** The bot that owns the space, e.g. "cos". Empty when unknown. */
  spaceOwner: string;
  objectTypes: readonly SpaceObjectTypeSummary[];
  selectedTypeSlug: string;
  onSelectType: (slug: string) => void;
  rows: readonly SpaceRecordRow[];
  /** Total matching records in the space, which may exceed `rows.length`. */
  total: number;
  recordsState: "loading" | "error" | "ready";
}

/**
 * The read-only space view: a line naming the space, the object types, and the
 * selected type's records. Pure — every state it can be in is a prop.
 */
export function AppDataSpaceView({
  spaceId,
  spaceName,
  spaceOwner,
  objectTypes,
  selectedTypeSlug,
  onSelectType,
  rows,
  total,
  recordsState,
}: AppDataSpaceViewProps) {
  const selected = objectTypes.find((t) => t.slug === selectedTypeSlug);
  return (
    <div className="opr-tool-scoped opr-app-data">
      <div className="opr-data-intro">
        <Eyebrow>Attached data space</Eyebrow>
        <p className="opr-scoped-note">
          This app reads and writes <strong>{spaceName}</strong>
          {spaceOwner ? <> , owned by @{spaceOwner}</> : null}. The same records
          are in Data, so what the app changes the operator sees, and what the
          operator changes the app sees.
        </p>
        <a className="opr-btn opr-btn-sm" href={`/data/${spaceId}`}>
          Open {spaceName} in Data
        </a>
      </div>

      {objectTypes.length === 0 ? (
        <EmptyState
          glyph="▦"
          title="This space has no object types yet"
          hint="The bot that owns the space defines its object types. Once it does, they show up here and the app can read them."
        />
      ) : (
        <>
          <div className="opr-data-toolbar">
            {objectTypes.map((type) => (
              <button
                key={type.slug}
                type="button"
                // opr-btn-primary is the existing emphasis variant — the
                // selected type reads as chosen in all three themes without a
                // new token or a new class.
                className={`opr-btn opr-btn-sm${type.slug === selectedTypeSlug ? " opr-btn-primary" : ""}`}
                aria-pressed={type.slug === selectedTypeSlug}
                onClick={() => onSelectType(type.slug)}
              >
                {type.namePlural}
                <span className="opr-data-block-sub">{type.recordCount}</span>
              </button>
            ))}
          </div>
          {selected ? (
            <SpaceRecordsBlock
              type={selected}
              rows={rows}
              total={total}
              state={recordsState}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

interface SpaceRecordsBlockProps {
  type: SpaceObjectTypeSummary;
  rows: readonly SpaceRecordRow[];
  total: number;
  state: "loading" | "error" | "ready";
}

function SpaceRecordsBlock({
  type,
  rows,
  total,
  state,
}: SpaceRecordsBlockProps) {
  return (
    <div className="opr-data-block">
      <div className="opr-data-block-head">
        {type.namePlural}
        <span className="opr-data-block-sub">
          {state === "ready"
            ? `${rows.length} of ${total} ${total === 1 ? "record" : "records"}`
            : "—"}
        </span>
      </div>
      {state === "loading" ? (
        <div
          className="opr-tool-scoped"
          role="status"
          aria-label="Loading records"
        >
          <div className="opr-skeleton opr-skel-row" />
          <div className="opr-skeleton opr-skel-row" style={{ marginTop: 8 }} />
        </div>
      ) : state === "error" ? (
        <div className="opr-data-empty">
          Could not read {type.namePlural.toLowerCase()} from this space right
          now. Try again in a moment.
        </div>
      ) : rows.length === 0 ? (
        <div className="opr-data-empty">
          No {type.namePlural.toLowerCase()} yet. The bot that owns this space
          fills it, and this app reads what lands here.
        </div>
      ) : (
        <table className="opr-data-table">
          <thead>
            <tr>
              {type.attributes.map((attribute) => (
                <th key={attribute.slug}>
                  <span className="opr-data-col-name">{attribute.name}</span>
                  <span className="opr-data-col-type">{attribute.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {type.attributes.map((attribute) => {
                  const cell = row.values[attribute.slug] ?? "";
                  return (
                    <td key={attribute.slug}>
                      {cell === "" ? (
                        <span className="opr-data-none">none</span>
                      ) : (
                        cell
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Wire shapes + normalization ─────────────────────────────────────────────
//
// The broker speaks internal/dataspace's snake_case JSON. Everything below is
// that translation and nothing else; the rules live in the Go store.

interface WireOption {
  id?: unknown;
  name?: unknown;
}
interface WireAttribute {
  slug?: unknown;
  name?: unknown;
  type?: unknown;
  options?: unknown;
}
interface WireObjectType {
  slug?: unknown;
  name?: unknown;
  name_plural?: unknown;
  record_count?: unknown;
  attributes?: unknown;
}
interface WireSchema {
  space?: { id?: unknown; name?: unknown; owner?: unknown };
  object_types?: unknown;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Option id -> option name, per attribute slug, so a stored id reads as text. */
type OptionNames = Record<string, Record<string, string>>;

/** Option id -> name for one attribute, so a stored id can be rendered. */
function parseOptionNames(raw: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  if (!Array.isArray(raw)) return names;
  for (const entry of raw) {
    const option = (entry ?? {}) as WireOption;
    const id = text(option.id);
    if (id) names[id] = text(option.name, id);
  }
  return names;
}

/** One object type's attributes, collecting its option names as it goes. */
function parseAttributes(
  raw: unknown,
  optionNames: OptionNames,
): SpaceAttributeSummary[] {
  if (!Array.isArray(raw)) return [];
  const attributes: SpaceAttributeSummary[] = [];
  for (const entry of raw) {
    const attribute = (entry ?? {}) as WireAttribute;
    const slug = text(attribute.slug);
    if (!slug) continue;
    attributes.push({
      slug,
      name: text(attribute.name, slug),
      type: text(attribute.type, "text"),
    });
    if (Array.isArray(attribute.options)) {
      optionNames[slug] = parseOptionNames(attribute.options);
    }
  }
  return attributes;
}

function parseSchema(raw: unknown): {
  spaceId: string;
  spaceName: string;
  spaceOwner: string;
  objectTypes: SpaceObjectTypeSummary[];
  optionNames: OptionNames;
} {
  const wire = (raw ?? {}) as WireSchema;
  const rawTypes = Array.isArray(wire.object_types) ? wire.object_types : [];
  const optionNames: OptionNames = {};
  const objectTypes = rawTypes.map((entry) => {
    const type = (entry ?? {}) as WireObjectType;
    const name = text(type.name, "Object type");
    return {
      slug: text(type.slug, name),
      name,
      namePlural: text(type.name_plural, name),
      recordCount: count(type.record_count),
      attributes: parseAttributes(type.attributes, optionNames),
    };
  });
  return {
    spaceId: text(wire.space?.id),
    spaceName: text(wire.space?.name, "this data space"),
    spaceOwner: text(wire.space?.owner),
    objectTypes,
    optionNames,
  };
}

/**
 * Render one stored value as text. Select and status hold OPTION IDS, so they
 * are resolved through the schema's option names — showing a raw
 * "opt_3f2a" would be honest but useless.
 */
function formatValue(value: unknown, names?: Record<string, string>): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : "";
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatValue(item, names))
      .filter((item) => item !== "")
      .join(", ");
  }
  if (typeof value === "string") return names?.[value] ?? value;
  return "";
}

function parseRecords(
  raw: unknown,
  optionNames: OptionNames,
): SpaceRecordRow[] {
  const records = (raw as { records?: unknown })?.records;
  if (!Array.isArray(records)) return [];
  return records.map((entry, index) => {
    const record = (entry ?? {}) as { id?: unknown; values?: unknown };
    const wireValues =
      record.values && typeof record.values === "object"
        ? (record.values as Record<string, unknown>)
        : {};
    const values: Record<string, string> = {};
    for (const [slug, value] of Object.entries(wireValues)) {
      values[slug] = formatValue(value, optionNames[slug]);
    }
    return { id: text(record.id, `record-${index}`), values };
  });
}

/** How many records the read-only preview pulls. The full table is in Data. */
const SPACE_PREVIEW_LIMIT = 25;

interface AppDataSpacePanelProps {
  spaceId: string;
}

/**
 * AppDataSpacePanel fetches the attached space's schema and the selected object
 * type's first page of records, then renders AppDataSpaceView. Read-only in v1:
 * editing lives in Data, one screen away.
 */
export function AppDataSpacePanel({ spaceId }: AppDataSpacePanelProps) {
  const [selectedSlug, setSelectedSlug] = useState("");

  const schemaQuery = useQuery({
    queryKey: ["operator-app-data-space", spaceId],
    refetchOnMount: "always",
    queryFn: async () =>
      parseSchema(await get(`/data/spaces/${encodeURIComponent(spaceId)}`)),
  });

  const objectTypes = useMemo(
    () => schemaQuery.data?.objectTypes ?? [],
    [schemaQuery.data],
  );
  // An unset (or stale) selection falls back to the first type, so the tab
  // always shows real rows rather than an empty frame.
  const activeSlug =
    objectTypes.find((type) => type.slug === selectedSlug)?.slug ??
    objectTypes[0]?.slug ??
    "";

  const recordsQuery = useQuery({
    queryKey: ["operator-app-data-records", spaceId, activeSlug],
    enabled: activeSlug !== "",
    refetchOnMount: "always",
    queryFn: async () => {
      const page = await post(
        `/data/spaces/${encodeURIComponent(spaceId)}/records/query`,
        { object_type: activeSlug, limit: SPACE_PREVIEW_LIMIT },
      );
      return {
        rows: parseRecords(page, schemaQuery.data?.optionNames ?? {}),
        total: count((page as { total?: unknown })?.total),
      };
    },
  });

  if (schemaQuery.isLoading) {
    return (
      <div
        className="opr-tool-scoped"
        role="status"
        aria-label="Loading data space"
      >
        <div className="opr-skeleton opr-skel-row" />
        <div className="opr-skeleton opr-skel-row" style={{ marginTop: 8 }} />
        <div className="opr-skeleton opr-skel-row" style={{ marginTop: 8 }} />
      </div>
    );
  }
  if (schemaQuery.isError || !schemaQuery.data) {
    return (
      <EmptyState
        glyph="▦"
        title="Could not read the attached data space"
        hint="This app is attached to a data space the workspace could not load right now. Try again in a moment."
      />
    );
  }

  const recordsState = recordsQuery.isError
    ? "error"
    : recordsQuery.isLoading || recordsQuery.isFetching
      ? "loading"
      : "ready";

  return (
    <AppDataSpaceView
      spaceId={spaceId}
      spaceName={schemaQuery.data.spaceName}
      spaceOwner={schemaQuery.data.spaceOwner}
      objectTypes={objectTypes}
      selectedTypeSlug={activeSlug}
      onSelectType={setSelectedSlug}
      rows={recordsQuery.data?.rows ?? []}
      total={recordsQuery.data?.total ?? 0}
      recordsState={activeSlug === "" ? "ready" : recordsState}
    />
  );
}
