// Client for the pi-mono agent's /tools/build endpoint — the app's chat teaches a
// workflow, the agent's create_tool tool authors it, and this returns the tool it
// made. Proxied via /agent in dev (see vite.config.ts). Mirrors the agent wire
// (agent/src/wire.ts ToolBuildRequest/ToolBuildResult).

import {
  authorToolFromDescription,
  type Tool,
  type ToolInput,
} from "./mockTools";

const SCHEMA_VERSION = 1;

interface HarnessTool {
  name: string;
  title: string;
  purpose: string;
  inputs: ToolInput[];
  code: string;
}

interface ToolBuildResult {
  tool: HarnessTool | null;
  narration: string;
  /** How the agent authored it: a real model, or the deterministic stub the
   * service falls back to when no model is available on that machine. */
  authored_by?: "model" | "stub";
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `tool_h${seq}`;
}

// Map the harness Tool (no FE-only id/calls/script naming) onto the FE Tool.
function toFeTool(h: HarnessTool, createdFrom: string): Tool {
  return {
    id: nextId(),
    title: h.title,
    name: h.name,
    purpose: h.purpose,
    inputs: h.inputs,
    script: h.code,
    createdFrom,
    calls: [],
  };
}

export interface BuiltTool {
  /** null = the service answered but declined; narration says why. */
  tool: Tool | null;
  narration: string;
  /** True when the harness was unreachable and we fell back to the local mock. */
  offline: boolean;
  /** "stub" when the service answered with its canned template because no
   * model is connected — callers must NOT present that as a built tool. */
  authoredBy: "model" | "stub";
}

/**
 * Ask the harness chat agent to build a tool for a described workflow. A
 * reachable service that returns no tool is a DECLINE (tool: null, narration
 * explains) — distinct from the offline fallback, whose mock tool exists only
 * so the caller has a shape; callers must never present offline or
 * stub-authored results as built.
 */
export async function buildToolFromChat(
  message: string,
  app: string,
): Promise<BuiltTool> {
  try {
    const res = await fetch("/agent/tools/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, message, app }),
      // A hung agent service must not wedge the chat: time out into the
      // offline fallback below. Real model authoring runs up to 45s on the
      // service side — this must outlast it.
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`harness ${res.status}`);
    const data = (await res.json()) as ToolBuildResult;
    return {
      tool: data.tool ? toFeTool(data.tool, message) : null,
      narration: data.narration,
      offline: false,
      // Older services omit the field; they only ever stub-authored.
      authoredBy: data.authored_by ?? "stub",
    };
  } catch {
    const tool = authorToolFromDescription(message);
    return {
      tool,
      narration: `Built ${tool.title}.`,
      offline: true,
      authoredBy: "stub",
    };
  }
}

// --- Calling a tool (POST /tools/call) --------------------------------------
// Mirrors agent/src/wire.ts ToolCallRequest/ToolCallResult. Executing is the
// AGENT's job: there is no mock execution fallback — offline is an error.

export interface ToolCallGate {
  capability: string;
  detail: string;
}

export interface ToolCallOutcome {
  status: "ok" | "needs_approval" | "error";
  result?: string;
  detail?: string;
  gate?: ToolCallGate;
  /** Every capability call the tool made, e.g. crm.deals({"since":"7d"}). */
  actions: string[];
}

/**
 * The app's chat calls a saved tool via the agent. `approved` carries the
 * human's answer to the approval card (gated capabilities default-deny).
 */
export async function callToolViaAgent(
  tool: Tool,
  args: Record<string, string>,
  approved = false,
): Promise<ToolCallOutcome> {
  try {
    const res = await fetch("/agent/tools/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        // FE Tool stores the code as `script`; the wire field is `code`.
        tool: {
          name: tool.name,
          title: tool.title,
          purpose: tool.purpose,
          inputs: tool.inputs,
          code: tool.script,
        },
        args,
        approved,
      }),
      // Generous: tool runs can drive slow capabilities (browser, sends), but
      // a hung agent still resolves into the error outcome below.
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`agent ${res.status}`);
    const data = (await res.json()) as ToolCallOutcome;
    return {
      ...data,
      actions: Array.isArray(data.actions) ? data.actions : [],
    };
  } catch {
    return {
      status: "error",
      detail:
        "Nex could not be reached to run this, so nothing happened. Give it a moment and try again.",
      actions: [],
    };
  }
}
