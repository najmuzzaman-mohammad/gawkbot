// Routines — a workflow IS a scheduled prompt run in the agent's chat (Claude
// Routines-style). Nothing to compile: the prompt goes into a chat session on a
// schedule, the agent calls its tools, the outcome lands as messages/artifacts.
// Disable and Publish-new-version belong to EACH routine, not the agent.
// FE-first mock; persistence + the real scheduler are the next slice.
// See docs/specs/operator-agent-routines.md.

export interface Routine {
  /** For LIVE routines this is the broker scheduler slug. */
  id: string;
  /** Plain-language name, e.g. "Monday pipeline recap". */
  name: string;
  /** The prompt the agent runs in its chat. */
  prompt: string;
  /** Cron expression / broker shorthand for live routines; a human label for
   * seeded mocks. Render through humanSchedule(). */
  schedule: string;
  enabled: boolean;
  /** Latest published version — the broker's revision history owns this. */
  version: number;
  /** FE-local: the prompt was edited since the last publish. Publishing sends
   * the edit to the broker as a new revision (with a change note). */
  draft?: boolean;
  lastRun?: string;
  /** The chat session this routine runs in (known for seeded mocks; live
   * routines resolve their session by slug via the sessions list). */
  sessionId?: string;
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  /** "routine" sessions are created by a schedule; "manual" by the operator. */
  kind: "routine" | "manual";
  at: string;
  /** Broker scheduler slug of the owning routine (routine sessions only). */
  routine?: string;
}

/** Schedule presets: a human label + the broker cron/shorthand it sends. */
export const SCHEDULE_PRESETS: ReadonlyArray<{ label: string; expr: string }> =
  [
    { label: "Every Monday 9:00", expr: "0 9 * * 1" },
    { label: "Weekdays 8:00", expr: "0 8 * * 1-5" },
    { label: "Every day 18:00", expr: "0 18 * * *" },
    { label: "Every 30 minutes", expr: "*/30 * * * *" },
    { label: "Every hour", expr: "hourly" },
  ];

const CRON_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Render a schedule for humans. Preset exprs map back to their label; common
 * cron shapes and shorthands translate ("0 9 * * 1" -> "Every Monday 9:00",
 * "4h" -> "Every 4 hours"); anything else falls back to "a custom schedule" —
 * a raw cron expression is developer material, never operator copy. */
export function humanSchedule(schedule: string): string {
  const expr = schedule.trim();
  const preset = SCHEDULE_PRESETS.find((p) => p.expr === expr);
  if (preset) return preset.label;

  const lower = expr.toLowerCase();
  if (lower === "hourly") return "Every hour";
  if (lower === "daily") return "Every day";
  if (lower === "weekly") return "Every week";
  const short = lower.match(/^(\d+)([mh])$/);
  if (short) {
    const n = Number(short[1]);
    const unit = short[2] === "m" ? "minute" : "hour";
    return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  }

  // Common 5-field cron shapes.
  const parts = expr.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, , dow] = parts;
    const everyMin = min.match(/^\*\/(\d+)$/);
    if (everyMin && hour === "*") return `Every ${everyMin[1]} minutes`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*") {
      const time = `${hour}:${min.padStart(2, "0")}`;
      if (dow === "*") return `Every day ${time}`;
      if (dow === "1-5") return `Weekdays ${time}`;
      if (/^\d$/.test(dow)) {
        const day = CRON_DAYS[Number(dow)];
        if (day) return `Every ${day} ${time}`;
      }
    }
  }

  // Already-human labels (contain letters, no cron glyphs) pass through.
  if (/[a-z]/i.test(expr) && !/[*/]/.test(expr)) return expr;
  return "a custom schedule";
}

/** Humanize a timestamp: an ISO/RFC3339 string becomes a short local
 * "Mon D, HH:MM"; a value that isn't a date (a seeded label like "12 minutes
 * ago", or "v3") passes through untouched. Shared by routine run-stamps and
 * artifact chips so both humanize the same way. */
export function formatStamp(value: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Render a last-run stamp: broker RFC3339 becomes a short local time; a
 * seeded human label ("12 minutes ago") renders as-is. */
export function formatLastRun(value: string): string {
  return formatStamp(value);
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}`;
}

export function newRoutine(
  name: string,
  prompt: string,
  schedule: string,
): Routine {
  return {
    id: nextId("rt"),
    name,
    prompt,
    schedule,
    enabled: true,
    version: 1,
    sessionId: nextId("sess"),
  };
}

/** Session key for "Open its chat": seeded mocks know their session id; live
 * routines hand over their scheduler slug, which the sessions list resolves. */
export function routineSessionKey(r: Routine): string {
  return r.sessionId ?? r.id;
}

export function newSession(
  title: string,
  kind: ChatSessionMeta["kind"],
): ChatSessionMeta {
  return { id: nextId("sess"), title, kind, at: "just now" };
}
