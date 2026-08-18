// Mock model for the "workflows as tools" spike (slice 1, FE-first). A Tool is an
// AI-authored, workflow-specific scripted capability the agent calls. Here the
// authoring and calling are DETERMINISTIC MOCKS so the founder can react to the
// shape before any backend writes real code. See
// docs/specs/operator-workflows-as-tools.md.

export interface ToolInput {
  name: string;
  type: "string" | "number" | "record";
}

export interface ToolCall {
  id: string;
  args: Record<string, string>;
  result: string;
  at: string;
}

export interface Tool {
  id: string;
  /** Plain-language title for a non-technical reader, e.g. "Score & route a lead". */
  title: string;
  /** Callable identifier the agent invokes, e.g. scoreAndFlag. */
  name: string;
  /** One line: what running this tool does. */
  purpose: string;
  inputs: ToolInput[];
  /** The (mock) script Nex wrote for this workflow. */
  script: string;
  /** The operator's own words that Nex turned into this tool. */
  createdFrom: string;
  calls: ToolCall[];
}

// A tiny keyword → shape table so a described workflow yields a plausible,
// recognizable tool instead of a generic stub. Order matters: first match wins.
const SHAPES: ReadonlyArray<{
  test: RegExp;
  name: string;
  title: string;
  purpose: string;
  inputs: ToolInput[];
  body: string;
  sampleArg: Record<string, string>;
  sampleResult: string;
}> = [
  {
    test: /\b(score|scor|rank|prioriti[sz]e|risk|rate|triage)\b/i,
    name: "scoreAndFlag",
    title: "Score & flag records",
    purpose:
      "Score each record against a rubric and flag the ones that need attention.",
    inputs: [{ name: "rubric", type: "string" }],
    body: [
      "const records = await data.list('records');",
      "const scored = [];",
      "for (const r of records) {",
      "  const score = await nex.ai.score(r, { rubric: rubric || 'priority' });",
      "  scored.push({ record: r, score, flagged: score >= 75 });",
      "}",
      "return { count: scored.length, flagged: scored.filter((s) => s.flagged) };",
    ].join("\n"),
    sampleArg: { rubric: "priority" },
    sampleResult: "12 records scored · 3 flagged for attention.",
  },
  {
    test: /\b(summar\w*|digest|weekly|report|recap|roll.?up|overview)\b/i,
    name: "weeklySummary",
    title: "Weekly summary",
    purpose: "Summarize this period's records into a glanceable recap.",
    inputs: [],
    body: [
      "const records = await data.list('records');",
      "if (records.length === 0) return { count: 0, summary: 'No records to summarize.' };",
      "const summary = await nex.ai.summarize(records, { style: 'concise recap' });",
      "return { count: records.length, summary };",
    ].join("\n"),
    sampleArg: {},
    sampleResult: "18 records this week · summarized into a 3-line recap.",
  },
  {
    test: /\b(draft|write|compose|follow.?up|email|reply|outreach|nudge|message|reminder)\b/i,
    name: "draftMessage",
    title: "Draft a message",
    purpose:
      "Draft a message about a record for your review before it goes out.",
    inputs: [{ name: "recordId", type: "string" }],
    body: [
      "const record = await data.get('records', recordId);",
      "if (!record) return { error: `No record found for ${recordId}.` };",
      "const draft = await nex.ai.write('message', {",
      "  context: record,",
      "  tone: 'warm, brief',",
      "});",
      "return { recordId, draft, status: 'draft — review before sending' };",
    ].join("\n"),
    sampleArg: { recordId: "rec-1" },
    sampleResult:
      "Drafted a warm, brief message — ready to review before sending.",
  },
];

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}`;
}

// Derive a plain-language title (for a non-technical reader) from a description:
// trim to a short phrase, drop a leading trigger clause, sentence-case it.
function humanTitle(description: string): string {
  let d = description.trim().replace(/\s+/g, " ");
  // Drop a leading "When … ," trigger so the title names the action.
  d = d.replace(/^when\b[^,]*,\s*/i, "");
  const words = d.split(" ").slice(0, 6).join(" ");
  const title = words.charAt(0).toUpperCase() + words.slice(1);
  return title.replace(/[.,;:]+$/, "");
}

// Derive a camelCase tool name from a free-text description when no shape matches,
// so an unknown workflow still yields a sensible callable name.
function deriveName(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 3);
  if (words.length === 0) return "runWorkflow";
  return words
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("");
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "when",
  "then",
  "and",
  "to",
  "for",
  "of",
  "on",
  "in",
  "with",
  "that",
  "this",
  "it",
  "new",
  "every",
  "each",
  "from",
  "into",
  "by",
  "at",
  "is",
  "are",
  "do",
  "i",
  "we",
  "want",
  "need",
  "should",
  "please",
  "can",
  "you",
]);

/**
 * Nex "writes a tool" for a described workflow — a deterministic mock. Matches a
 * known shape when it can (recognizable script + inputs), else synthesizes a
 * named stub from the operator's words.
 */
export function authorToolFromDescription(description: string): Tool {
  const desc = description.trim();
  const shape = SHAPES.find((s) => s.test.test(desc));
  if (shape) {
    return {
      id: nextId("tool"),
      title: shape.title,
      name: shape.name,
      purpose: shape.purpose,
      inputs: shape.inputs,
      script: `async function ${shape.name}(${shape.inputs
        .map((i) => i.name)
        .join(", ")}) {\n  ${shape.body.replace(/\n/g, "\n  ")}\n}`,
      createdFrom: desc,
      calls: [],
    };
  }
  const name = deriveName(desc);
  return {
    id: nextId("tool"),
    title: humanTitle(desc),
    name,
    purpose: desc.charAt(0).toUpperCase() + desc.slice(1),
    inputs: [{ name: "input", type: "string" }],
    script: `async function ${name}(input) {\n  // Nex scripted this from: "${desc}"\n  const result = await nex.run(input);\n  return result;\n}`,
    createdFrom: desc,
    calls: [],
  };
}

/**
 * The agent "calls" a tool — a deterministic mock result. Uses the known shape's
 * sample result when available, else echoes the args.
 */
export function callTool(tool: Tool, args: Record<string, string>): ToolCall {
  const shape = SHAPES.find((s) => s.name === tool.name);
  const result = shape
    ? shape.sampleResult
    : `${tool.name}(${Object.values(args).join(", ") || "…"}) → done`;
  return { id: nextId("call"), args, result, at: "just now" };
}

/** Suggested args for a one-click "call it" in the mock, from the known shape. */
export function sampleArgsFor(tool: Tool): Record<string, string> {
  return SHAPES.find((s) => s.name === tool.name)?.sampleArg ?? {};
}

/**
 * Seed the app's Tools tab. Empty on purpose: an agent shows ONLY the tools the
 * operator actually taught it. Fabricated "as if Nex had already built them"
 * seeds leaked into the purpose line and the "from N conversations" chip and
 * made real agents claim conversations that never happened; the Tools tab has
 * an honest empty state instead.
 */
export function seedToolsForApp(_appName?: string): Tool[] {
  return [];
}
