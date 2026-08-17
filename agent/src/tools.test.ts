import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "./service.js";
import { authorTool, authorToolWithModel, buildTool, type ToolAuthorOptions } from "./tools.js";

type CompleteFn = NonNullable<ToolAuthorOptions["complete"]>;

// A minimal stand-in for pi-ai's complete: returns canned text content (and can
// count calls), so these tests never hit a live model.
function fakeComplete(text: string, captured?: { calls: number }): CompleteFn {
	return (async () => {
		if (captured) captured.calls++;
		return { content: [{ type: "text", text }] };
	}) as unknown as CompleteFn;
}

const MODEL_TOOL_JSON = JSON.stringify({
	name: "chaseUnpaidInvoices",
	title: "Chase unpaid invoices",
	purpose: "Find overdue invoices and draft a chase note for each.",
	inputs: ["invoice"],
	code: "async function chaseUnpaidInvoices(invoice) {\n  return nex.run(invoice);\n}",
});

// --- deterministic (stub) path ---------------------------------------------

test("authorTool matches a known workflow shape", () => {
	const t = authorTool("score and triage each record by risk");
	expect(t.name).toBe("scoreAndFlag");
	expect(t.title).toBe("Score & flag records");
	expect(t.inputs.map((i) => i.name)).toEqual(["rubric"]);
	expect(t.code).toContain("async function scoreAndFlag(rubric)");
});

test("authorTool honors an explicit leading name over a keyword-hijacked shape", () => {
	// QA HIGH-2 (clean-workspace rerun): this exact demo-handoff instruction
	// returned the scoreAndRouteLead TEMPLATE — "lead"/"score" in the purpose
	// matched shape 1 and the explicitly requested tool silently never existed.
	const t = authorTool("postHandoffToSlack — Post the lead, score, and reason to #ae-handoffs.");
	expect(t.name).toBe("postHandoffToSlack");
	expect(t.code).toContain("async function postHandoffToSlack(input)");
	// The purpose/title come from the text AFTER the name, not the name itself.
	expect(t.purpose).toBe("Post the lead, score, and reason to #ae-handoffs.");
	expect(t.title.toLowerCase()).not.toContain("posthandofftoslack");
});

test("authorTool still uses a shape when the explicit name AGREES with it", () => {
	const t = authorTool("scoreAndFlag — Score and flag records that need attention.");
	expect(t.name).toBe("scoreAndFlag");
	expect(t.title).toBe("Score & flag records");
	expect(t.code).toContain("nex.ai.score");
});

test("authorTool does not read prose with a dash as an explicit name", () => {
	// No interior capital → not camelCase → not a name; shape matching applies.
	const t = authorTool("okay — score and triage each record by risk");
	expect(t.name).toBe("scoreAndFlag");
});

test("authorTool synthesizes a name + plain title for an unknown workflow", () => {
	const t = authorTool("When an invoice arrives, archive old records nightly");
	// Trigger clause dropped for the title; stopwords dropped + camelCased for name.
	expect(t.title).toBe("Archive old records nightly");
	expect(t.name).toBe("invoiceArrivesArchive");
	expect(t.inputs.map((i) => i.name)).toEqual(["input"]);
});

test("authorTool title cuts at a natural boundary, not mid-clause (LOW-9)", () => {
	// QA LOW-9: this exact instruction produced "Count the open tasks and tell" —
	// truncated mid-clause after a dangling "and". The title must end before the
	// coordinating conjunction instead.
	const t = authorTool("When I ask, count the open tasks and tell me the number.");
	expect(t.title).toBe("Count the open tasks");
	expect(t.title).not.toContain("and tell");
	// A short instruction (<= budget) is still kept whole.
	expect(authorTool("When it fires, archive the stale records").title).toBe("Archive the stale records");
});

test("authorTool synthesizes a valid identifier from a digit-leading workflow", () => {
	// "2026" leads after stopword filtering — bare camelCasing would emit
	// `async function 2026RenewalSync(...)`, which is not legal JS.
	const t = authorTool("2026 renewal sync");
	expect(t.name).toBe("run2026RenewalSync");
	expect(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t.name)).toBe(true);
	expect(t.code).toContain(`async function ${t.name}(input)`);
});

test("authorTool keeps a multi-line description inside the scripted-from comment", () => {
	// A raw newline in the description would terminate the `//` comment and spill
	// text into the function body. It must be collapsed to a single space.
	const t = authorTool("archive old records\nnightly across regions");
	const commentLine = t.code.split("\n").find((l) => l.includes("Nex scripted this from"));
	expect(commentLine).toContain('archive old records nightly across regions"');
});

test("buildTool returns the tool + a narration (stub by default)", async () => {
	const r = await buildTool("draft a follow-up for a stalled deal");
	expect(r.tool?.name).toBe("draftMessage");
	expect(r.narration).toContain("Built");
	expect(r.authored_by).toBe("stub");
});

test("buildTool does not spend a model call unless tryModel is set", async () => {
	const cap = { calls: 0 };
	const r = await buildTool("archive old records nightly", { complete: fakeComplete(MODEL_TOOL_JSON, cap) });
	expect(cap.calls).toBe(0);
	expect(r.authored_by).toBe("stub");
});

// --- model path --------------------------------------------------------------

test("buildTool uses the model's tool when it answers with valid JSON", async () => {
	const r = await buildTool("chase unpaid invoices weekly", { tryModel: true, complete: fakeComplete(MODEL_TOOL_JSON) });
	expect(r.authored_by).toBe("model");
	expect(r.tool?.name).toBe("chaseUnpaidInvoices");
	expect(r.tool?.title).toBe("Chase unpaid invoices");
	expect(r.tool?.inputs).toEqual([{ name: "invoice", type: "string" }]);
	expect(r.tool?.code).toContain("async function chaseUnpaidInvoices(invoice)");
	expect(r.narration).toContain("Chase unpaid invoices");
});

test("buildTool falls back to the stub on a garbage model reply", async () => {
	const r = await buildTool("draft a follow-up for a stalled deal", {
		tryModel: true,
		complete: fakeComplete("sorry, I cannot help with that"),
	});
	expect(r.authored_by).toBe("stub");
	expect(r.tool?.name).toBe("draftMessage"); // the deterministic shape, not the model's
});

test("buildTool falls back to the stub when the model call throws", async () => {
	const throwing = (async () => {
		throw new Error("provider unreachable");
	}) as unknown as CompleteFn;
	const r = await buildTool("draft a follow-up for a stalled deal", { tryModel: true, complete: throwing });
	expect(r.authored_by).toBe("stub");
	expect(r.tool?.name).toBe("draftMessage");
});

test("buildTool rejects a model tool that calls a capability not in the catalog", async () => {
	// The model authored valid JS, but against crm.deals — a capability the
	// domain-neutral catalog no longer exposes. The smoke run's static reference
	// check must catch it (the single placeholder run might never reach the call)
	// and fall back to the stub rather than ship a tool that cannot run here.
	const bogus = JSON.stringify({
		name: "oldSalesTool",
		title: "Old sales tool",
		purpose: "uses a removed capability",
		inputs: [],
		code: "async function oldSalesTool() { const d = await crm.deals({ since: '7d' }); return d.length; }",
	});
	const r = await buildTool("summarize the deals", {
		tryModel: true,
		complete: fakeComplete(bogus),
	});
	expect(r.authored_by).toBe("stub");
	expect(r.tool?.code).not.toContain("crm.deals");
});

test("buildTool falls back to the stub when the model tool fails validation", async () => {
	// Parseable JSON, but no code -> not a usable tool.
	const r = await buildTool("draft a follow-up for a stalled deal", {
		tryModel: true,
		complete: fakeComplete('{"name":"draftIt","title":"Draft it","inputs":[]}'),
	});
	expect(r.authored_by).toBe("stub");
});

test("authorToolWithModel coerces inputs and derives a missing title from the description", async () => {
	// inputs mixes strings, {name} objects, and garbage; title is omitted.
	const raw = JSON.stringify({
		name: "syncRenewals",
		inputs: ["deal", { name: "owner" }, 42, {}, null, "  "],
		code: "async function syncRenewals(deal, owner) { return nex.run(deal); }",
	});
	const t = await authorToolWithModel("When a renewal nears, sync renewal owners weekly", { complete: fakeComplete(raw) });
	expect(t.inputs).toEqual([
		{ name: "deal", type: "string" },
		{ name: "owner", type: "string" },
	]);
	expect(t.title).toBe("Sync renewal owners weekly"); // humanized from the description
	expect(t.purpose).toBe("When a renewal nears, sync renewal owners weekly");
});

test("authorToolWithModel rejects before calling the model when the signal is already aborted", async () => {
	const cap = { calls: 0 };
	const ctrl = new AbortController();
	ctrl.abort(new Error("client gone"));
	await expect(
		authorToolWithModel("x", { complete: fakeComplete(MODEL_TOOL_JSON, cap), signal: ctrl.signal }),
	).rejects.toThrow("client gone");
	expect(cap.calls).toBe(0); // no model call spent on a dropped request
});

// --- service ------------------------------------------------------------------

let server: ReturnType<typeof createServer>;
let base: string;
let prevToolAuthorModel: string | undefined;
beforeAll(() => {
	// TOOL_AUTHOR_MODEL=0 forces the deterministic stub (serviceAuthor.ts): with
	// authoring auto-detected per host, an unset env on a dev machine with the
	// claude CLI would make this suite hit a live model. Pin it off; restore the
	// shell's value in afterAll.
	prevToolAuthorModel = process.env.TOOL_AUTHOR_MODEL;
	process.env.TOOL_AUTHOR_MODEL = "0";
	server = createServer({ port: 0 });
	base = server.url.toString().replace(/\/$/, "");
});
afterAll(() => {
	server.stop(true);
	if (prevToolAuthorModel === undefined) delete process.env.TOOL_AUTHOR_MODEL;
	else process.env.TOOL_AUTHOR_MODEL = prevToolAuthorModel;
});

test("POST /tools/build creates a tool", async () => {
	const res = await fetch(`${base}/tools/build`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ schema_version: 1, message: "draft a follow-up for a stalled deal", app: "Pipeline" }),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.tool.name).toBe("draftMessage");
	expect(body.tool.inputs.map((i: { name: string }) => i.name)).toEqual(["recordId"]);
	expect(body.narration).toContain("Built");
	expect(body.authored_by).toBe("stub");
});

test("POST /tools/build rejects a schema mismatch", async () => {
	const res = await fetch(`${base}/tools/build`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ schema_version: 99, message: "x" }),
	});
	expect(res.status).toBe(400);
});
