/**
 * buildActivity — turns the App Builder's raw HeadlessEvent stream into a
 * compact, human-readable activity feed where each tool call is ONE row that
 * resolves running → done/✗ (no zombie spinners).
 *
 * The raw stream emits a `tool_use` event and a separate `tool_result` event
 * per call; rendered naively that's two cards and a spinner that never
 * resolves. Here we merge them: a `tool_result` resolves the matching open
 * `tool_use` (FIFO per turn+tool), and a turn boundary (`idle`/`manifest`) or
 * `error` resolves anything still open — so the feed never strands a spinner.
 *
 * A turn-level `error` (the SESSION died, e.g. provider connection error)
 * resolves still-open rows to "interrupted", not "error": those calls never
 * failed, they just never got a result. A `reconnecting` event does the same
 * and appends an already-resolved "Reconnecting" row so the retry is visible.
 */

export type BuildActivityStatus = "running" | "done" | "error" | "interrupted";

export interface BuildActivityItem {
  id: string;
  /** e.g. "Writing", "Running", "Reading", "Publishing". */
  verb: string;
  /** e.g. "src/App.tsx", "bun run build". May be empty. */
  target: string;
  status: BuildActivityStatus;
  /** short result/error summary, shown when resolved. */
  note?: string;
}

/** Narrow view of a HeadlessEvent — only the fields the feed needs. */
export interface BuildEvent {
  type: string;
  toolName: string;
  detail: string;
  text: string;
  turnId: string;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Pull the relevant HeadlessEvents out of the raw SSE stream lines. */
export function extractBuildEvents(
  lines: ReadonlyArray<{ parsed?: Record<string, unknown> }>,
): BuildEvent[] {
  const out: BuildEvent[] = [];
  for (const line of lines) {
    const p = line.parsed;
    if (!p || p.kind !== "headless_event") continue;
    out.push({
      type: asString(p.type),
      toolName: asString(p.tool_name),
      detail: asString(p.detail),
      text: asString(p.text),
      turnId: asString(p.turn_id),
    });
  }
  return out;
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function parseArgs(detail: string): Record<string, unknown> {
  if (!detail.trim()) return {};
  try {
    const v = JSON.parse(detail);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Map a tool name + serialized args into a "Verb target" pair. */
export function humanizeToolEvent(
  toolName: string,
  detail: string,
): { verb: string; target: string } {
  const args = parseArgs(detail);
  const str = (k: string): string => asString(args[k]);
  // Strip an MCP namespace prefix (mcp__<server>__register_app -> register_app).
  const name = toolName.replace(/^mcp__[^_]*__/, "");
  const path = str("file_path") || str("path") || str("notebook_path");

  switch (name.toLowerCase()) {
    case "write":
      return { verb: "Writing", target: lastSegment(path) };
    case "edit":
    case "multiedit":
      return { verb: "Editing", target: lastSegment(path) };
    case "read":
      return { verb: "Reading", target: lastSegment(path) };
    case "bash":
      // Never quote the raw shell command at the operator — classify it.
      return { verb: bashVerb(str("command")), target: "" };
    case "glob":
    case "grep":
      // Raw regex/glob patterns are developer material; the operator just
      // needs to know the bot is looking around.
      return { verb: "Searching", target: "the project" };
    case "todowrite":
      return { verb: "Planning", target: "" };
    case "webfetch":
      return { verb: "Fetching", target: truncate(str("url"), 48) };
    case "register_app":
      return { verb: "Publishing", target: str("name") || "the app" };
    case "get_app":
      return { verb: "Reading", target: "app source" };
    case "list_apps":
      return { verb: "Checking", target: "existing apps" };
    case "propose_app":
      return { verb: "Proposing", target: str("name") || "an app" };
    default:
      // Unknown internal tools stay generic — raw names and args are
      // developer material, not operator narration.
      return { verb: "Working", target: "" };
  }
}

/** Classify a shell command into an operator-facing verb (no raw command). */
function bashVerb(command: string): string {
  const c = command.trim().toLowerCase();
  if (
    /(^|\s|&&\s*)(bun|npm|pnpm|yarn|pip|go get|cargo|brew)\s+(install|add|i\b)/.test(
      c,
    )
  ) {
    return "Installing dependencies";
  }
  if (/tsc|typecheck|lint|biome|vet|prettier/.test(c))
    return "Checking the code";
  if (/(^|\s)(test|vitest|jest|pytest|go test)\b/.test(c))
    return "Running tests";
  if (/(^|\s)(build|vite build|make)\b/.test(c)) return "Building";
  return "Running a setup step";
}

/** Heuristic error sniff on a tool_result payload: explicit error envelopes
 * and the classic crash prefixes. Conservative on purpose — a false checkmark
 * hides failures, a false ✗ cries wolf. */
function looksLikeToolError(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed && typeof parsed === "object") {
      const o = parsed as { is_error?: unknown; error?: unknown };
      if (o.is_error === true) return true;
      if (typeof o.error === "string" && o.error.trim()) return true;
    }
  } catch {
    // plain text — fall through
  }
  return /^(error|fatal|panic):/i.test(t);
}

/** Condense a tool_result payload into a short one-line note. */
export function summarizeResult(text: string): string {
  const t = text.trim();
  if (!t) return "";
  try {
    const v = JSON.parse(t);
    if (v && typeof v === "object") {
      const r = v as Record<string, unknown>;
      const pick =
        asString(r.message) ||
        asString(r.status) ||
        asString(r.result) ||
        asString(r.text);
      if (pick) return truncate(pick, 56);
      return `${Object.keys(r).length} fields`;
    }
  } catch {
    // plain text
  }
  return truncate(t, 56);
}

interface MutableItem extends BuildActivityItem {
  turn: string;
}

/**
 * Reduce an ordered HeadlessEvent list into resolving activity rows.
 * Pure and order-dependent: feed it the full ordered event list each render.
 */
export function reduceBuildActivity(
  events: ReadonlyArray<BuildEvent>,
): BuildActivityItem[] {
  const items: MutableItem[] = [];
  // FIFO queues of open (running) item indices, keyed by turn+tool.
  const open = new Map<string, number[]>();
  let seq = 0;

  // Most native tools (Read/Write/Bash) emit a tool_result that references its
  // call by id, not name, so the runner can't tag it and drops the event — rows
  // would otherwise spin until the turn ends. The bot works one tool at a
  // time, so the arrival of the NEXT tool_use means the prior tool finished:
  // resolve still-running rows in the turn to "done". The open queue is left
  // intact, so a named tool_result (when one arrives) still attaches its note.
  // Only the active tool keeps spinning — a live cursor, no zombies.
  const markPriorDone = (turn: string) => {
    for (const item of items) {
      if (item.turn === turn && item.status === "running") {
        item.status = "done";
      }
    }
  };

  const resolveTurn = (turn: string, status: "done" | "interrupted") => {
    for (const item of items) {
      if (item.turn === turn && item.status === "running") {
        item.status = status;
      }
    }
    for (const key of [...open.keys()]) {
      if (key.startsWith(`${turn} `)) open.delete(key);
    }
  };

  for (const ev of events) {
    const key = `${ev.turnId} ${ev.toolName}`;
    switch (ev.type) {
      case "tool_use": {
        markPriorDone(ev.turnId);
        const { verb, target } = humanizeToolEvent(ev.toolName, ev.detail);
        items.push({
          id: `${ev.turnId}:${ev.toolName}:${seq++}`,
          verb,
          target,
          status: "running",
          turn: ev.turnId,
        });
        const q = open.get(key) ?? [];
        q.push(items.length - 1);
        open.set(key, q);
        break;
      }
      case "tool_result": {
        const q = open.get(key);
        const note = summarizeResult(ev.text);
        // An error payload must not render as a checkmark (2026-08-16
        // audit: the feed could literally never show a failure).
        const failed = looksLikeToolError(ev.text);
        if (q && q.length > 0) {
          const idx = q.shift() as number;
          items[idx].status = failed ? "error" : "done";
          if (note) items[idx].note = note;
        } else {
          const { verb, target } = humanizeToolEvent(ev.toolName, "");
          items.push({
            id: `${ev.turnId}:${ev.toolName}:${seq++}`,
            verb,
            target,
            status: failed ? "error" : "done",
            note: note || undefined,
            turn: ev.turnId,
          });
        }
        break;
      }
      case "error":
        // The session died mid-turn; open calls were interrupted, not failed.
        resolveTurn(ev.turnId, "interrupted");
        break;
      case "reconnecting":
        // The provider connection dropped and the Go side is retrying. Open
        // rows were interrupted; the appended row is born resolved (never
        // "running") so it can not become a zombie spinner.
        resolveTurn(ev.turnId, "interrupted");
        items.push({
          id: `${ev.turnId}:reconnecting:${seq++}`,
          verb: "Reconnecting",
          target: "",
          status: "done",
          note: truncate(ev.text, 56) || "connection dropped — retrying",
          turn: ev.turnId,
        });
        break;
      case "idle":
      case "manifest":
        resolveTurn(ev.turnId, "done");
        break;
      default:
        break;
    }
  }

  return items.map(({ turn: _turn, ...rest }) => rest);
}
