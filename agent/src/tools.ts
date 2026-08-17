// The chat agent's create_tool tool, on the pi-mono stack. The operator teaches a
// workflow in the app's chat; the agent turns it into a callable Tool by calling
// create_tool. This is the ONLY way tools are made — there is no build-a-tool UI,
// and a human never runs a tool (they are agent tools).
//
// Two authoring paths:
//   - MODEL (opt-in): one structured pi-ai `complete` call writes real `code` from
//     the description — mirrors buildAgent.ts (schema prompt, extractJson, hand-built
//     abort/timeout, `opts.complete` override for tests).
//   - STUB (default + fallback): the deterministic keyword->shape port shared with
//     the FE mock and the executor's expectations, so /tools/build is real end to
//     end WITHOUT a model call and never blocks on an unreachable model.

import { complete, type Context, type Model, type StreamOptions } from "@mariozechner/pi-ai";
import { apiKeyFor, resolveModel } from "./model.js";
import { asError, deadlineSignal, textOf } from "./modelCall.js";
import { runTool } from "./toolRuntime.js";
import { extractJson, type Tool, type ToolBuildResult, type ToolInput } from "./wire.js";

interface Shape {
	test: RegExp;
	name: string;
	title: string;
	purpose: string;
	inputs: string[];
	code: string;
}

// Keyword -> tool shape (first match wins). Kept in sync with the FE
// web/src/operator/tools/mockTools.ts SHAPES so a taught workflow yields the same
// recognizable tool everywhere.
const SHAPES: readonly Shape[] = [
	{
		test: /\b(score|fit|route|lead|assign)\b/i,
		name: "scoreAndRouteLead",
		title: "Score & route a lead",
		purpose: "Score a lead's fit and route hot ones to the right AE.",
		inputs: ["lead"],
		code: [
			"async function scoreAndRouteLead(lead) {",
			"  const fit = await nex.ai.score(lead, { rubric: 'ICP fit' });",
			"  if (fit >= 75) {",
			"    const ae = await crm.ownerFor(lead);",
			"    await crm.assign(lead, ae);",
			"    return `Fit ${fit} -> routed to ${ae.name}`;",
			"  }",
			"  return `Fit ${fit} -> left in the queue`;",
			"}",
		].join("\n"),
	},
	{
		test: /\b(summary|summar|pipeline|digest|weekly|report|recap)\b/i,
		name: "weeklyPipelineSummary",
		title: "Weekly pipeline summary",
		purpose: "Summarize last week's pipeline movement into a glanceable recap.",
		inputs: [],
		code: [
			"async function weeklyPipelineSummary() {",
			"  const deals = await crm.deals({ since: '7d' });",
			"  const moved = deals.filter((d) => d.stageChanged);",
			"  return nex.ai.summarize(moved, { style: 'exec recap' });",
			"}",
		].join("\n"),
	},
	{
		test: /\b(draft|follow.?up|email|reply|outreach|nudge|stall)\b/i,
		name: "draftFollowup",
		title: "Draft a follow-up email",
		purpose: "Draft a follow-up email for a stalled deal in the rep's voice.",
		inputs: ["deal"],
		code: [
			"async function draftFollowup(deal) {",
			"  const ctx = await crm.dealContext(deal);",
			"  return nex.ai.write('follow-up email', { context: ctx, tone: 'warm, brief' });",
			"}",
		].join("\n"),
	},
];

const STOPWORDS = new Set([
	"the", "a", "an", "my", "our", "when", "then", "and", "to", "for", "of", "on",
	"in", "with", "that", "this", "it", "new", "every", "each", "from", "into",
	"by", "at", "is", "are", "do", "i", "we", "want", "need", "should", "please",
	"can", "you",
]);

function toInputs(names: string[]): ToolInput[] {
	return names.map((name) => ({ name, type: "string" }));
}

function camel(words: string[]): string {
	return words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
}

// Coordinating conjunctions where a long instruction can be cut without leaving a
// dangling fragment: "count the open tasks AND tell me the number" -> stop before
// "and". Kept to coordinators (not "to"/"if") so short imperatives are not clipped.
const CLAUSE_BREAK = new Set(["and", "or", "then", "but", "so", "plus", "also", "nor"]);
const TITLE_MAX_WORDS = 6;
const TITLE_MIN_WORDS = 3;

function bareWord(w: string): string {
	return w.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Trim a lead phrase to a title-length budget WITHOUT cutting mid-clause. When
 * the phrase is longer than the budget, end it at the last natural boundary inside
 * the kept window — before a coordinating conjunction, or after a comma — so we
 * never emit "… and tell". Short phrases pass through whole. */
function naturalTitle(lead: string): string {
	const words = lead.split(/\s+/).filter(Boolean);
	if (words.length <= TITLE_MAX_WORDS) return words.join(" ");
	const window = words.slice(0, TITLE_MAX_WORDS);
	let cut = window.length;
	for (let i = window.length - 1; i >= TITLE_MIN_WORDS; i--) {
		if (CLAUSE_BREAK.has(bareWord(window[i]))) {
			cut = i; // drop the conjunction and everything the truncation orphaned after it
			break;
		}
		if (/[,;]$/.test(window[i])) {
			cut = i + 1; // a clause that ends on this word is complete — keep through it
			break;
		}
	}
	return window.slice(0, cut).join(" ");
}

/** Human title from a described workflow: drop a leading "When ... ," trigger,
 * cut to a title length at a natural clause boundary, sentence-case the rest.
 * Shared by the stub author and the model path (when the model omits a title). */
function humanTitle(description: string, fallback: string): string {
	const lead = description.trim().replace(/^when\b[^,]*,\s*/i, "");
	const titleWords = naturalTitle(lead);
	return (titleWords ? titleWords[0].toUpperCase() + titleWords.slice(1) : fallback).replace(/[.,;:]+$/, "");
}

// An instruction can LEAD with an explicit camelCase tool name — the demo-call
// handoff always sends "postHandoffToSlack — Post the lead, score, …". Strict
// camelCase (an interior capital) so prose with a dash ("ok — do this") never
// reads as a name.
const EXPLICIT_NAME = /^\s*([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\s*[—–:-]\s+(.+)$/s;

/** Derive a create_tool spec from a described workflow — a known shape, else a
 * synthesized camelCase name + plain-language title. Deterministic.
 *
 * An explicit leading name is an ORDER, not a hint: a keyword shape applies only
 * when it AGREES on the name. Without this, purpose words like "lead"/"score" in
 * "postHandoffToSlack — Post the lead, score, …" hijacked the request into the
 * scoreAndRouteLead template — the service returned 200 with the WRONG tool and
 * the requested one silently never existed. */
export function authorTool(description: string): Tool {
	const desc = description.trim();
	const explicit = EXPLICIT_NAME.exec(desc);
	const requested = explicit?.[1];
	// What the tool is ABOUT: the purpose after an explicit name, else the whole
	// instruction. Titles, purposes, and the code comment derive from this.
	const about = explicit?.[2].trim() || desc;
	const shape = SHAPES.find((s) => s.test.test(desc) && (!requested || s.name === requested));
	if (shape) {
		return { name: shape.name, title: shape.title, purpose: shape.purpose, inputs: toInputs(shape.inputs), code: shape.code };
	}
	const words = about
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w && !STOPWORDS.has(w));
	const rawName = requested ?? (words.length ? camel(words.slice(0, 3)) : "runWorkflow");
	// A digit-leading word would yield `async function 2026RenewalSync` — not a
	// legal identifier. Prefix "run" (keeping the camelCase tail) when needed.
	const name = /^[A-Za-z_$]/.test(rawName) ? rawName : `run${rawName[0].toUpperCase()}${rawName.slice(1)}`;
	// The description is interpolated into a `//` line comment: a newline in it
	// would terminate the comment and spill raw text into the function body.
	const commentDesc = about.replace(/\s+/g, " ");
	return {
		name,
		title: humanTitle(about, name),
		purpose: about ? about[0].toUpperCase() + about.slice(1) : name,
		inputs: [{ name: "input", type: "string" }],
		code: `async function ${name}(input) {\n  // Nex scripted this from: "${commentDesc}"\n  return nex.run(input);\n}`,
	};
}

// ---------------------------------------------------------------------------
// Model authoring (the pi-model path): the agent WRITES the tool's code.
// ---------------------------------------------------------------------------

// The create_tool brief. Lives here (not wire.ts): it is an authoring detail of
// this module, not part of the FE <-> agent contract.
export const TOOL_SCHEMA_PROMPT = `You are the create_tool author for an operator tool-builder. The operator described a repeatable workflow they want as a callable tool. WRITE that tool and OUTPUT ONLY a single JSON object (no prose, no code fence) of this shape:

{"name": str, "title": str, "purpose": str, "inputs": [str], "code": str}

- name: a camelCase callable id, e.g. "scoreAndRouteLead".
- title: plain language for a non-technical operator, e.g. "Score & route a lead".
- purpose: one line — what running it does.
- inputs: the argument names the tool takes (may be empty).
- code: a complete async JavaScript function named exactly like "name", taking the inputs as parameters, that performs the workflow.

The code runs against these capabilities (use them; do not invent others). All are async — await every call:
- nex.ai.score(subject, { rubric }) -> number 0-100
- nex.ai.summarize(items, { style }) -> string
- nex.ai.write(kind, { context, tone }) -> string
- nex.run(input) -> opaque fallback for ONE genuinely un-decomposable step inside a larger flow
- integrations.call(platform, action, params) -> call a connected integration (e.g. integrations.call("gmail", "GMAIL_FETCH_EMAILS", { max_results: 10 })); reads return data, writes are held for human approval
- nex.browser(goal) -> drive the operator's browser to accomplish a goal when no integration exists (needs the operator's approval)
- nex.send(target, content) -> external send (needs the operator's approval)
- crm.deals({ since }) -> array of deal objects; crm.ownerFor(lead) -> { name }; crm.assign(lead, owner) -> confirmation string; crm.dealContext(deal) -> { deal, stage, lastTouch, owner } (lastTouch is a HUMAN string like "9 days ago", not a date — do not Date.parse it)

Runtime facts your code must respect:
- Every input parameter arrives as a STRING (the chat binds arguments as text). Parse numbers with Number(...) and guard NaN; JSON.parse only when the operator is told to paste JSON.
- There is no reliable wall clock in the sandbox — compute "days since" from fields the data provides, never from Date.now().
- nex.ai.* return plain strings/numbers; do not JSON.parse them.

Quality bar (the operator will read and rely on this code):
- NEVER write a tool whose body is just nex.run(input) — that is not a tool, it is a shrug. Decompose the workflow into real steps with the specific capabilities above; if the workflow genuinely cannot be decomposed, still express the parts you can (validation, shaping, summary) around the one opaque step.
- Sends are drafts first: build the content, return it in the result, and call nex.send only when the described workflow explicitly says to send. Subject lines are part of the send target/metadata, not pasted into the body.
- Return structured objects ({count, summary, items}) rather than bare strings when the workflow produces more than one fact; format money and dates for humans.
- Handle missing/empty inputs explicitly (guard and say what is missing in the return) instead of letting undefined flow through the math.

Output the JSON object and nothing else.`;

// A stalled provider must not pin /tools/build open forever — fall back to a hard
// cap when the caller passes no signal.
const DEFAULT_AUTHOR_TIMEOUT_MS = 45_000;

export interface ToolAuthorOptions {
	model?: Model<string>;
	apiKey?: string;
	/** Caller's abort signal (e.g. the HTTP request's signal). Aborts the model call. */
	signal?: AbortSignal;
	/** Hard timeout for the model call; defaults to DEFAULT_AUTHOR_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Override the pi-ai completion call in tests so they never hit a live model. */
	complete?: typeof complete;
}

/** Coerce model-emitted inputs — strings or {name} objects — into ToolInputs;
 * garbage entries are skipped. */
function coerceInputs(raw: unknown): ToolInput[] {
	if (!Array.isArray(raw)) return [];
	const out: ToolInput[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			if (entry.trim()) out.push({ name: entry.trim(), type: "string" });
		} else if (entry && typeof entry === "object") {
			const name = (entry as { name?: unknown }).name;
			if (typeof name === "string" && name.trim()) out.push({ name: name.trim(), type: "string" });
		}
	}
	return out;
}

/** Validate/coerce raw model JSON into a Tool. Throws when the model did not
 * produce a usable tool (missing name/code) — the caller falls back to the stub. */
function validateTool(raw: Record<string, unknown>, description: string): Tool {
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	const code = typeof raw.code === "string" ? raw.code.trim() : "";
	if (!name) throw new Error("model tool output missing name");
	if (!code) throw new Error("model tool output missing code");
	const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : humanTitle(description, name);
	const purpose = typeof raw.purpose === "string" && raw.purpose.trim() ? raw.purpose.trim() : description.trim();
	return { name, title, purpose, inputs: coerceInputs(raw.inputs), code };
}

/** Author a Tool via the pi-ai model layer: one structured `complete` call against
 * TOOL_SCHEMA_PROMPT. Mirrors buildAgent.buildWorkflow (same abort/timeout shape). */
export async function authorToolWithModel(message: string, opts: ToolAuthorOptions = {}): Promise<Tool> {
	const model = opts.model ?? resolveModel();
	const completeFn = opts.complete ?? complete;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTHOR_TIMEOUT_MS;
	const ctx: Context = {
		systemPrompt: TOOL_SCHEMA_PROMPT,
		messages: [{ role: "user", content: message.trim(), timestamp: Date.now() }],
	};

	// Caller signal + hard timeout composed into one signal (modelCall.ts).
	const deadline = deadlineSignal(opts.signal, timeoutMs, {
		timeoutMessage: `tool authoring timed out after ${timeoutMs}ms`,
		abortFallback: "tool authoring aborted",
	});

	try {
		// Fail loud before spending a model call when we are already aborted.
		if (deadline.signal.aborted) throw asError(deadline.signal.reason, "tool authoring aborted");
		const res = await completeFn(model, ctx, {
			apiKey: opts.apiKey ?? apiKeyFor(model),
			signal: deadline.signal,
		} satisfies StreamOptions);
		return validateTool(extractJson(textOf(res.content as { type: string; text?: string }[])), message);
	} finally {
		deadline.done();
	}
}

// ---------------------------------------------------------------------------
/** Execute the freshly-authored tool once in the SIMULATED sandbox with
 * placeholder string args. Returns the crash detail for hard failures
 * (undefined-property crashes, syntax-level issues), or "" when the run
 * completed or failed only in expected gated/simulated ways. */
async function smokeRunTool(tool: Tool): Promise<string> {
	try {
		const args: Record<string, string> = {};
		for (const input of tool.inputs) args[input.name] = "42";
		const res = await runTool(tool, args, { timeoutMs: 8_000 });
		if (res.status === "error" && res.detail) {
			const d = res.detail;
			// Gated sends / capability denials are EXPECTED in the sandbox;
			// only genuine code crashes count.
			if (/is not a function|is not defined|undefined is not|Cannot read|SyntaxError|ReferenceError|TypeError/.test(d)) {
				return d.slice(0, 240);
			}
		}
		return "";
	} catch (err) {
		return String(err instanceof Error ? err.message : err).slice(0, 240);
	}
}

// buildTool: the tool agent's turn (model first when enabled, stub as fallback)
// ---------------------------------------------------------------------------

/** buildTool's runtime result: ToolBuildResult plus how the tool was authored.
 * Kept local (not wire.ts) — the wire contract is unchanged; the serialized JSON
 * is a superset the FE can ignore or adopt later. */
export interface ToolBuildOutcome extends ToolBuildResult {
	authored_by: "model" | "stub";
}

export interface ToolBuildOptions extends ToolAuthorOptions {
	/**
	 * Attempt the model authoring path. Default FALSE: there is no cheap reachability
	 * check for the default model (Ollama availability is a network question), so an
	 * unconfigured deployment must not eat the authoring timeout per request. The
	 * service opts in via TOOL_AUTHOR_MODEL=1.
	 */
	tryModel?: boolean;
}

/** The tool agent's turn: teach a workflow -> create_tool -> the tool it made.
 * Tries the model author when enabled; ANY model failure (unreachable, timeout,
 * bad JSON, validation) falls back to the deterministic stub. */
export async function buildTool(message: string, opts: ToolBuildOptions = {}): Promise<ToolBuildOutcome> {
	if (opts.tryModel === true) {
		try {
			let tool = await authorToolWithModel(message, opts);
			// Smoke-run before the tool is trusted: execute once in the
			// simulated sandbox with placeholder args. A tool that crashes on
			// first contact ("lastTouchAt" on a shape that has "lastTouch",
			// Date.parse of a human string) demo-fails in the operator's face
			// — one repair attempt with the crash appended, then give up to
			// the stub (2026-08-17 quality audit: tool-quality graded 3/10
			// on exactly this class).
			const crash = await smokeRunTool(tool);
			if (crash) {
				tool = await authorToolWithModel(
					`${message}

Your previous attempt crashed on a smoke run with: ${crash}
Fix the code (respect the documented capability shapes) and output the corrected tool.`,
					opts,
				);
				const crash2 = await smokeRunTool(tool);
				if (crash2) throw new Error(`authored tool crashes on smoke run: ${crash2}`);
			}
			return { tool, narration: `Built ${tool.title}.`, authored_by: "model" };
		} catch {
			// Fall through to the stub: /tools/build stays real end to end, key-free.
		}
	}
	const tool = authorTool(message);
	return { tool, narration: `Built ${tool.title}.`, authored_by: "stub" };
}
