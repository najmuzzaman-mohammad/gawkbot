// AppDataTab — the Data tab: the app's real, persisted BACKING DATABASE.
//
// Every app has a small typed store of its own (per app, server-side). The app
// derives its model ONCE from the source it reads, persists it with the bridge
// `db.*` API (defineTable + upsert), and renders from it — see "The app's
// database" in the app-scaffold AI_RULES. This tab is a DETERMINISTIC, direct
// read of that store: GET /apps/{id}/db → the tables the app itself wrote. No AI
// reconstruction, no re-fetch of the source — what the app persisted is what
// shows here, so the two never drift.

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { get } from "../../api/client";
import { EmptyState } from "../components/EmptyState";
import { Eyebrow } from "../components/primitives";

interface AppDataTabProps {
  appId: string;
}

interface ModelColumn {
  name: string;
  type: string;
}
interface ModelTable {
  name: string;
  columns: ModelColumn[];
  rows: Record<string, unknown>[];
}

// Parse the broker's GET /apps/{id}/db payload into clean tables. Defensive: the
// wire shape is trusted (our own broker), but tolerate missing fields so a
// half-written table never crashes the tab.
function parseTables(raw: unknown): ModelTable[] {
  const tables = (raw as { tables?: unknown })?.tables;
  if (!Array.isArray(tables)) return [];
  return tables.map((t) => {
    const tt = (t ?? {}) as {
      name?: unknown;
      columns?: unknown;
      rows?: unknown;
    };
    const columns = Array.isArray(tt.columns)
      ? tt.columns
          .map((c) => {
            const cc = (c ?? {}) as { name?: unknown; type?: unknown };
            return {
              name: String(cc.name ?? "").trim(),
              type: String(cc.type ?? "string").trim() || "string",
            };
          })
          .filter((c) => c.name)
      : [];
    // Keep only plain objects: a null or array entry would crash the cell
    // lookup (row[c.name]) at render time.
    const rows = Array.isArray(tt.rows)
      ? tt.rows.filter(
          (r): r is Record<string, unknown> =>
            !!r && typeof r === "object" && !Array.isArray(r),
        )
      : [];
    return {
      name: String(tt.name ?? "Table").trim() || "Table",
      columns,
      rows,
    };
  });
}

export function AppDataTab({ appId }: AppDataTabProps) {
  const dbQuery = useQuery({
    queryKey: ["operator-app-db", appId],
    // The app writes to its DB through the bridge in a different component
    // tree, so nothing invalidates this key. It is a cheap local read: always
    // refetch on mount so the tab never shows a stale snapshot.
    refetchOnMount: "always",
    queryFn: async (): Promise<ModelTable[]> => {
      const res = await get<{ tables?: unknown }>(
        `/apps/${encodeURIComponent(appId)}/db`,
      );
      return parseTables(res);
    },
  });

  if (dbQuery.isLoading) {
    // Table-shaped skeleton, not a 320px void: the wait previews the shape
    // of what loads (2026-08-16 delight audit).
    return (
      <div className="opr-tool-scoped" role="status" aria-label="Loading data">
        <div className="opr-skeleton opr-skel-row" />
        <div className="opr-skeleton opr-skel-row" style={{ marginTop: 8 }} />
        <div className="opr-skeleton opr-skel-row" style={{ marginTop: 8 }} />
      </div>
    );
  }

  if (dbQuery.isError) {
    return (
      <EmptyState
        glyph="▦"
        title="Could not read this agent’s data"
        hint="The workspace could not load this agent’s database right now. Try again in a moment."
      />
    );
  }

  const tables = dbQuery.data ?? [];
  if (tables.length === 0) {
    return (
      <EmptyState
        glyph="▦"
        portraitSlug={appId}
        title="No data yet"
        hint="Nothing saved yet. After its first run, everything this agent records lands here as tables you own: browse every row, export any table as CSV or JSON. No BI ticket required."
      />
    );
  }

  return (
    <div className="opr-tool-scoped opr-app-data">
      <div className="opr-data-intro">
        <Eyebrow>This agent’s database</Eyebrow>
        <p className="opr-scoped-note">
          The tables this agent derived and saved, read straight from its own
          database. Nothing reconstructed. Every table exports as CSV or JSON:
          your data, no export ticket.
        </p>
      </div>
      {tables.map((t, i) => (
        // Name+index key: parseTables falls back to "Table" for a half-written
        // table, so bare names can collide and misapply reconciliation.
        <ModelTableView key={`${t.name}-${i}`} table={t} />
      ))}
    </div>
  );
}

// ── Making stored values LEGIBLE ────────────────────────────────────────────
//
// Apps persist real shapes: JSON-encoded arrays of findings, ISO timestamps,
// long strings. Rendering those as flat truncated text made the tab useless —
// the 2026-08-15 QA verdict was "the data there does not seem usable". The
// rules here turn storage back into information without inventing anything:
//   - JSON-in-string cells parse and render structurally (arrays of objects
//     become nested mini-tables on expand; empty arrays read "none").
//   - Dates humanize ("Aug 15, 9:59 AM"), full ISO on hover.
//   - Every row expands to a full detail view, so truncation never hides data.
//   - Each table exports as CSV or JSON — the operator owns this data.

type Parsed =
  | { kind: "empty" }
  | { kind: "scalar"; text: string }
  | { kind: "date"; text: string; full: string }
  | { kind: "list"; items: unknown[] }
  | { kind: "record"; value: Record<string, unknown> };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function humanizeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function parseValue(v: unknown, colType: string): Parsed {
  if (v == null || v === "") return { kind: "empty" };
  if (typeof v === "string") {
    const t = v.trim();
    if (
      (colType === "date" || ISO_DATE_RE.test(t)) &&
      !Number.isNaN(Date.parse(t))
    ) {
      return { kind: "date", text: humanizeDate(t), full: t };
    }
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        return parseValue(JSON.parse(t), colType);
      } catch {
        // Not JSON after all — fall through to scalar.
      }
    }
    return { kind: "scalar", text: t };
  }
  if (Array.isArray(v)) {
    return v.length === 0 ? { kind: "empty" } : { kind: "list", items: v };
  }
  if (typeof v === "object") {
    return { kind: "record", value: v as Record<string, unknown> };
  }
  return { kind: "scalar", text: String(v) };
}

/** Short inline summary for a cell; the row expansion carries the detail. */
function CellSummary({ parsed }: { parsed: Parsed }) {
  switch (parsed.kind) {
    case "empty":
      return <span className="opr-data-none">none</span>;
    case "date":
      return <span title={parsed.full}>{parsed.text}</span>;
    case "list": {
      const scalars = parsed.items.every((x) => typeof x !== "object");
      if (scalars) {
        const joined = parsed.items.map((x) => String(x)).join(", ");
        return (
          <span title={joined}>
            {joined.length > 60 ? `${joined.slice(0, 60)}…` : joined}
          </span>
        );
      }
      return (
        <span className="opr-data-chip">
          {parsed.items.length} {parsed.items.length === 1 ? "item" : "items"}
        </span>
      );
    }
    case "record":
      return <span className="opr-data-chip">details</span>;
    default:
      return (
        <span title={parsed.text.length > 60 ? parsed.text : undefined}>
          {parsed.text.length > 60
            ? `${parsed.text.slice(0, 60)}…`
            : parsed.text}
        </span>
      );
  }
}

/** Full-width structural rendering used inside a row's expansion. */
function ValueDetail({ parsed }: { parsed: Parsed }) {
  switch (parsed.kind) {
    case "empty":
      return <span className="opr-data-none">none</span>;
    case "date":
      return (
        <span>
          {parsed.text} <span className="opr-data-none">({parsed.full})</span>
        </span>
      );
    case "list": {
      const objects = parsed.items.filter(
        (x): x is Record<string, unknown> =>
          !!x && typeof x === "object" && !Array.isArray(x),
      );
      if (objects.length === parsed.items.length && objects.length > 0) {
        // Array of records → a readable nested table over the union of keys.
        const keys: string[] = [];
        for (const o of objects) {
          for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
        }
        return (
          <table className="opr-data-table opr-data-nested">
            <thead>
              <tr>
                {keys.map((k) => (
                  <th key={k}>
                    <span className="opr-data-col-name">{k}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {objects.map((o, i) => (
                <tr key={`${String(o[keys[0]] ?? "")}-${i}`}>
                  {keys.map((k) => (
                    <td key={k}>
                      <CellSummary parsed={parseValue(o[k], "string")} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      return <span>{parsed.items.map((x) => String(x)).join(", ")}</span>;
    }
    case "record":
      return (
        <dl className="opr-data-kv">
          {Object.entries(parsed.value).map(([k, v]) => (
            <div className="opr-data-kv-row" key={k}>
              <dt>{k}</dt>
              <dd>
                <ValueDetail parsed={parseValue(v, "string")} />
              </dd>
            </div>
          ))}
        </dl>
      );
    default:
      return <span className="opr-data-full-text">{parsed.text}</span>;
  }
}

// ── Export: the operator owns this data ─────────────────────────────────────

function downloadBlob(filename: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportTable(table: ModelTable, format: "csv" | "json") {
  if (format === "json") {
    downloadBlob(
      `${table.name}.json`,
      "application/json",
      JSON.stringify(table.rows, null, 2),
    );
    return;
  }
  const cols = table.columns.map((c) => c.name);
  const lines = [
    cols.map(csvEscape).join(","),
    ...table.rows.map((r) => cols.map((c) => csvEscape(r[c])).join(",")),
  ];
  downloadBlob(`${table.name}.csv`, "text/csv", lines.join("\n"));
}

function ModelTableView({ table }: { table: ModelTable }) {
  const [openRow, setOpenRow] = useState<number | null>(null);
  return (
    <div className="opr-data-block">
      <div className="opr-data-block-head">
        {table.name}
        <span className="opr-data-block-sub">
          {table.rows.length} {table.rows.length === 1 ? "row" : "rows"}
        </span>
        {table.rows.length > 0 ? (
          <span className="opr-data-export">
            <button
              type="button"
              className="opr-btn opr-btn-sm"
              onClick={() => exportTable(table, "csv")}
            >
              CSV
            </button>
            <button
              type="button"
              className="opr-btn opr-btn-sm"
              onClick={() => exportTable(table, "json")}
            >
              JSON
            </button>
          </span>
        ) : null}
      </div>
      {table.rows.length === 0 ? (
        <div className="opr-data-empty">
          Defined, no rows yet — the agent has declared this table but not
          written to it.
        </div>
      ) : (
        <table className="opr-data-table">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c.name}>
                  <span className="opr-data-col-name">{c.name}</span>
                  <span className="opr-data-col-type">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => {
              const open = openRow === i;
              return (
                <Fragment key={`row-${i}`}>
                  <tr
                    className={`opr-data-row${open ? " is-open" : ""}`}
                    onClick={() => setOpenRow(open ? null : i)}
                  >
                    {table.columns.map((c) => (
                      <td key={c.name}>
                        <CellSummary parsed={parseValue(row[c.name], c.type)} />
                      </td>
                    ))}
                  </tr>
                  {open ? (
                    <tr className="opr-data-detail-row">
                      <td colSpan={table.columns.length}>
                        <dl className="opr-data-kv">
                          {table.columns.map((c) => (
                            <div className="opr-data-kv-row" key={c.name}>
                              <dt>{c.name}</dt>
                              <dd>
                                <ValueDetail
                                  parsed={parseValue(row[c.name], c.type)}
                                />
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
