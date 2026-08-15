// DemoCapture — the context a "Demo workflow to Nex" screen-share call hands to
// the AI when the call ends.
//
// The whole point of demonstrating instead of describing is that Nex can watch
// the operator's actual screen and capture FAR more than words: which apps and
// screens they touched, the concrete elements they interacted with (stable
// selectors + sample values), the API calls those screens fired (sniffed from
// the network, the discovery half of "browsersniff"), and the entities that
// matter (integrations, channels, thresholds, fields, actions). That captured
// context is what lets the AI start BUILDING or MODIFYING the tool the moment
// the call ends, instead of asking the operator to re-explain in chat.
//
// In the shipped product (operator spec S5/S6) this payload is produced by a
// computer-use agent over the captured screen plus browsersniff over the HAR.
// Here it is assembled as an honest mock: the SHAPE is the real contract; the
// values are representative of the inbound-routing scenario so the handoff can
// be seen working. Secrets never enter this payload — only endpoint shapes and
// element metadata.

import type { InternalTool } from "../mock/data";
import type { ObservedScreen } from "./observeClient";

export interface CapturedScreen {
  // Human label for the screen/app the operator demonstrated on.
  label: string;
  // Where it lives (origin or route), never with query secrets.
  url: string;
  // What was observed about the DOM (framework, surface kind).
  dom: string;
}

export interface CapturedSelector {
  // What the element is, in the operator's terms ("Company field").
  label: string;
  // Coarse role so the AI knows how to drive it.
  role: "input" | "button" | "link" | "table" | "select" | "form";
  // A stable selector observed on the page (data-*, aria, semantic).
  selector: string;
  // A sample value seen in the element, if any (never a secret).
  sample?: string;
}

export interface CapturedApiCall {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // The endpoint shape sniffed from the network (no tokens, no query secrets).
  endpoint: string;
  // The integration the call maps to, when recognized.
  integration: string;
  // What the call does, in plain terms.
  purpose: string;
}

export interface CapturedEntity {
  kind: "integration" | "channel" | "threshold" | "field" | "action";
  value: string;
}

export interface DemoCaptureLine {
  who: "you" | "ai";
  text: string;
}

// What the demonstrated work calls for: an app UI the team works in, a
// scheduled routine the agent runs itself, or both.
export type DemoKind = "app" | "routine" | "both";

// A routine the call captured: the scheduled job the built agent should run.
export interface CapturedRoutine {
  name: string;
  prompt: string;
  /** Cron expression or broker shorthand (daily, hourly, Nh, "0 9 * * 1"). */
  schedule: string;
}

// A callable tool the call identified the agent will need.
export interface CapturedTool {
  name: string;
  purpose: string;
}

export interface DemoCapture {
  mode: "build" | "modify";
  // Present in modify mode: the tool the change was demonstrated on.
  toolId?: string;
  toolName?: string;
  // What to build from the demo: an app UI, a routine, or both. The agent
  // always gets built; this decides what gets set up on it.
  kind: DemoKind;
  // Present when kind is routine/both: the scheduled job to create.
  routine?: CapturedRoutine;
  // The tools the agent will need for this work (created after the build).
  tools: CapturedTool[];
  // The narrated goal, as a clean instruction the build engine can plan from.
  goal: string;
  // The AI's reflect-back at the end of the call (the drafted tool or change).
  summary: string;
  // What the operator said, verbatim.
  transcript: DemoCaptureLine[];
  // Everything Nex observed on the demonstrated screens.
  screens: CapturedScreen[];
  selectors: CapturedSelector[];
  apiCalls: CapturedApiCall[];
  entities: CapturedEntity[];
  // Ground truth read off the real page by cua-driver during the call (the AX
  // component tree + visible text per distinct screen, in workflow order). This
  // is what lets the build read the actual components, not guess from pixels.
  observed?: ObservedScreen[];
}

// Turn the capture into the seed the build engine starts from. The narrated goal
// leads (so a keyword planner reads it cleanly), then EVERYTHING the demo call
// captured follows — the AI's reflect-back, the observed apps/APIs, screens,
// elements, key details, and the FULL transcript — so the build works from the
// real session, not a one-line summary.
export function capturePromptSeed(capture: DemoCapture): string {
  const lines: string[] = [capture.goal];

  if (capture.summary) {
    lines.push("", `What Nex drafted on the call: ${capture.summary}`);
  }

  // What the demo calls for, so the build plans an agent, not just a screen.
  const kindLine =
    capture.kind === "routine"
      ? "This work runs on a SCHEDULE (a routine) — the agent does it itself; the app UI is for reviewing outcomes."
      : capture.kind === "both"
        ? "This work needs BOTH: an app UI the team works in AND a scheduled routine the agent runs itself."
        : "This work needs an APP UI the team works in.";
  lines.push("", `What to build: ${kindLine}`);
  if (capture.routine) {
    lines.push(
      `Routine captured on the call: "${capture.routine.name}" — runs ${capture.routine.schedule} — prompt: ${capture.routine.prompt}`,
    );
  }
  if (capture.tools.length > 0) {
    lines.push(
      `Tools the agent will need: ${capture.tools
        .map((t) => `${t.name} (${t.purpose})`)
        .join("; ")}`,
    );
  }

  const details: string[] = [];
  if (capture.entities.length > 0) {
    details.push(
      `Key details: ${capture.entities
        .map((e) => `${e.value} (${e.kind})`)
        .join(", ")}`,
    );
  }
  if (capture.apiCalls.length > 0) {
    details.push(
      `Integrations & APIs observed: ${capture.apiCalls
        .map(
          (c) =>
            `${c.integration} ${c.method} ${c.endpoint}${
              c.purpose ? ` — ${c.purpose}` : ""
            }`,
        )
        .join("; ")}`,
    );
  }
  if (capture.screens.length > 0) {
    details.push(
      `Screens used: ${capture.screens
        .map((s) => (s.url ? `${s.label} (${s.url})` : s.label))
        .join(", ")}`,
    );
  }
  if (capture.selectors.length > 0) {
    details.push(
      `Elements interacted with: ${capture.selectors
        .map((s) => (s.sample ? `${s.label} = ${s.sample}` : s.label))
        .join(", ")}`,
    );
  }
  if (details.length > 0) {
    lines.push("", "Captured from the screen share:", ...details);
  }

  if (capture.observed && capture.observed.length > 0) {
    lines.push(
      "",
      "Real page structure Nex read off the screen during the call (ground " +
        "truth — the apps, their components, and content in the order shown):",
    );
    for (const screen of capture.observed) {
      lines.push(`- ${screen.app} — ${screen.title}`);
      if (screen.components.length > 0) {
        lines.push(
          `  components: ${screen.components
            .map((c) => `${c.role}:${c.label}`)
            .join(", ")}`,
        );
      }
      if (screen.text) {
        lines.push(`  text: ${screen.text}`);
      }
    }
  }

  if (capture.transcript.length > 0) {
    lines.push("", "Full transcript of the demo call:");
    for (const line of capture.transcript) {
      lines.push(`${line.who === "ai" ? "Nex" : "Operator"}: ${line.text}`);
    }
  }

  return lines.join("\n");
}

// The argument shape the realtime model fills in via its draft_workflow tool.
// It mirrors DemoCapture's observation fields but every list is optional, since
// a live model may surface only some of them. Roles/kinds arrive as free strings
// and are coerced into the typed unions on the way in.
export interface DraftWorkflowArgs {
  goal: string;
  summary?: string;
  kind?: string;
  routine?: { name?: string; prompt?: string; schedule?: string };
  tools?: Array<{ name?: string; purpose?: string }>;
  screens?: Array<{ label?: string; url?: string; dom?: string }>;
  selectors?: Array<{
    label?: string;
    role?: string;
    selector?: string;
    sample?: string;
  }>;
  apiCalls?: Array<{
    method?: string;
    endpoint?: string;
    integration?: string;
    purpose?: string;
  }>;
  entities?: Array<{ kind?: string; value?: string }>;
}

const SELECTOR_ROLES: ReadonlySet<CapturedSelector["role"]> = new Set([
  "input",
  "button",
  "link",
  "table",
  "select",
  "form",
]);
const API_METHODS: ReadonlySet<CapturedApiCall["method"]> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const ENTITY_KINDS: ReadonlySet<CapturedEntity["kind"]> = new Set([
  "integration",
  "channel",
  "threshold",
  "field",
  "action",
]);

// Strip query strings and fragments from a model-reported URL/endpoint so
// secrets carried in the query (e.g. a shared-screen `...?token=...`) never
// cross the handoff boundary. Enforces the "no query secrets" contract.
function stripQueryAndFragment(value: string): string {
  const trimmed = value.trim();
  const cut = trimmed.search(/[?#]/);
  return cut >= 0 ? trimmed.slice(0, cut) : trimmed;
}

// Build a DemoCapture from what the realtime model reported, coercing loose
// strings into the typed unions so the rest of the handoff is unchanged. The
// only capture source: the scripted example call no longer fabricates one
// (2026-08-15 audit).
export function demoCaptureFromDraft(
  args: DraftWorkflowArgs,
  opts: {
    mode: "build" | "modify";
    tool?: { id: string; name: string };
    transcript: DemoCaptureLine[];
    observed?: ObservedScreen[];
  },
): DemoCapture {
  const kind = (args.kind ?? "").toLowerCase();
  const routine = args.routine;
  const routinePrompt = (routine?.prompt ?? "").trim();
  return {
    mode: opts.mode,
    toolId: opts.tool?.id,
    toolName: opts.tool?.name,
    kind: kind === "routine" || kind === "both" ? kind : "app",
    // A routine needs a prompt to run; name and schedule get safe defaults.
    ...(routinePrompt
      ? {
          routine: {
            name: (routine?.name ?? "").trim() || "Scheduled routine",
            prompt: routinePrompt,
            schedule: (routine?.schedule ?? "").trim() || "daily",
          },
        }
      : {}),
    tools: (args.tools ?? [])
      .filter((t) => (t.name ?? "").trim() && (t.purpose ?? "").trim())
      .map((t) => ({
        name: (t.name ?? "").trim(),
        purpose: (t.purpose ?? "").trim(),
      })),
    goal: (args.goal ?? "").trim(),
    summary: (args.summary ?? "").trim(),
    transcript: opts.transcript,
    ...(opts.observed && opts.observed.length > 0
      ? { observed: opts.observed }
      : {}),
    screens: (args.screens ?? [])
      .filter((s) => (s.label ?? "").trim())
      .map((s) => ({
        label: (s.label ?? "").trim(),
        url: stripQueryAndFragment(s.url ?? ""),
        dom: (s.dom ?? "").trim(),
      })),
    selectors: (args.selectors ?? [])
      .filter((s) => (s.selector ?? "").trim())
      .map((s) => {
        const role = (s.role ?? "").toLowerCase() as CapturedSelector["role"];
        return {
          label: (s.label ?? "element").trim(),
          role: SELECTOR_ROLES.has(role) ? role : "input",
          selector: (s.selector ?? "").trim(),
          ...(s.sample ? { sample: s.sample.trim() } : {}),
        };
      }),
    apiCalls: (args.apiCalls ?? [])
      .filter((c) => (c.endpoint ?? "").trim())
      .map((c) => {
        const method = (
          c.method ?? "GET"
        ).toUpperCase() as CapturedApiCall["method"];
        return {
          method: API_METHODS.has(method) ? method : "GET",
          endpoint: stripQueryAndFragment(c.endpoint ?? ""),
          integration: (c.integration ?? "").trim(),
          purpose: (c.purpose ?? "").trim(),
        };
      }),
    entities: (args.entities ?? [])
      .filter((e) => (e.value ?? "").trim())
      .map((e) => {
        const kind = (e.kind ?? "").toLowerCase() as CapturedEntity["kind"];
        return {
          kind: ENTITY_KINDS.has(kind) ? kind : "field",
          value: (e.value ?? "").trim(),
        };
      }),
  };
}

// Small accessor for UI summaries: how much context the call captured.
export function captureCounts(capture: DemoCapture): {
  screens: number;
  selectors: number;
  apiCalls: number;
  entities: number;
} {
  return {
    screens: capture.screens.length,
    selectors: capture.selectors.length,
    apiCalls: capture.apiCalls.length,
    entities: capture.entities.length,
  };
}
