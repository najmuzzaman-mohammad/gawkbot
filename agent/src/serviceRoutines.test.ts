// Service-level coverage for the persistence routes: /tools/build persistence,
// /tools, /routines/run (the broker's fire entrypoint), /sessions (+message),
// /artifacts. Offline: the store + sessions point at a tmp dir, the build
// engine is stubbed, authoring is the deterministic stub (TOOL_AUTHOR_MODEL
// unset), and tool runs use the simulated capability tree — never a live
// model or broker. Routine DEFINITIONS (cron, versioning, run history) live in
// the broker's scheduler registry, so there is no routine CRUD here.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { resolveToolAuthoring } from "./serviceAuthor.js";
import { createServer } from "./service.js";
import { PiSessions } from "./sessions.js";
import { AgentStore } from "./store.js";
import { authorTool, type ToolAuthorOptions } from "./tools.js";
import type { SessionMessage, SessionMeta, StoredArtifact, StoredTool, WorkflowSpec } from "./wire.js";

// Deterministic MODEL-path authoring: echoes the stub author's tool through the
// real authorToolWithModel flow, so builds land authored_by="model" and the
// endpoint's persist path (version bumps, quarantine recovery) stays testable
// now that stub-authored tools are never persisted.
const fakeComplete = (async (_model: unknown, ctx: { messages: { content: unknown }[] }) => {
	const msg = typeof ctx.messages[0]?.content === "string" ? (ctx.messages[0].content as string) : "";
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: JSON.stringify(authorTool(msg)) }],
		api: "openai-completions",
		provider: "fake",
		model: "fake",
		usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}) as ToolAuthorOptions["complete"];
const fakeAuthoring: typeof resolveToolAuthoring = () => ({
	via: "api_key",
	model: {
		id: "fake",
		name: "fake",
		api: "openai-completions",
		provider: "fake",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	},
	complete: fakeComplete,
});

async function* fakeBuild() {
	yield {
		type: "spec" as const,
		spec: { name: "n", tool_id: "t", narration: "", clarify: null, steps: [] } as WorkflowSpec,
	};
}

let tmp: string;
let dataDir: string;
let server: ReturnType<typeof createServer>;
let base: string;
let prevToolAuthorModel: string | undefined;
beforeAll(() => {
	// Pin authoring to the deterministic stub: per-host auto-detect
	// (serviceAuthor.ts) would hit a live model on machines with the claude CLI.
	prevToolAuthorModel = process.env.TOOL_AUTHOR_MODEL;
	process.env.TOOL_AUTHOR_MODEL = "0";
	tmp = mkdtempSync(join(tmpdir(), "wuphf-agent-svc-"));
	dataDir = join(tmp, "data");
	server = createServer({
		port: 0,
		buildStream: fakeBuild,
		store: new AgentStore(dataDir),
		sessions: new PiSessions(dataDir),
		authoring: fakeAuthoring,
	});
	base = server.url.toString().replace(/\/$/, "");
});
afterAll(() => {
	server.stop(true);
	rmSync(tmp, { recursive: true, force: true });
	if (prevToolAuthorModel === undefined) delete process.env.TOOL_AUTHOR_MODEL;
	else process.env.TOOL_AUTHOR_MODEL = prevToolAuthorModel;
});

function post(path: string, body: unknown, method = "POST"): Promise<Response> {
	return fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("POST /tools/build with app persists the tool; same name bumps version", async () => {
	const r1 = (await (await post("/tools/build", { schema_version: 1, message: "summarize the weekly pipeline", app: "sales" })).json()) as {
		tool: StoredTool;
	};
	expect(r1.tool.name).toBe("weeklySummary");
	expect(r1.tool.version).toBe(1);
	const r2 = (await (await post("/tools/build", { schema_version: 1, message: "weekly pipeline digest", app: "sales" })).json()) as {
		tool: StoredTool;
	};
	expect(r2.tool.version).toBe(2);
	// Persisted and listable per agent.
	const listed = (await (await fetch(`${base}/tools?agent=sales`)).json()) as { tools: StoredTool[] };
	expect(listed.tools).toHaveLength(1);
	expect(listed.tools[0].version).toBe(2);
	// No app -> authored but NOT persisted (and no version on the response tool).
	const r3 = (await (await post("/tools/build", { schema_version: 1, message: "draft a follow-up email" })).json()) as {
		tool: StoredTool;
	};
	expect(r3.tool.name).toBe("draftMessage");
	expect(r3.tool.version).toBeUndefined();
	expect(((await (await fetch(`${base}/tools?agent=sales`)).json()) as { tools: StoredTool[] }).tools).toHaveLength(1);
});

test("POST /tools/build reports the resolved authoring route as via", async () => {
	// The FE branches its stub copy on this: via "none" means nothing is
	// configured; a real route with a stub result means the model attempt
	// failed and the operator should retry, not reconfigure.
	const r = (await (await post("/tools/build", { schema_version: 1, message: "summarize open invoices" })).json()) as {
		via: string;
	};
	expect(r.via).toBe("api_key");
});

test("POST /routines/run (a broker fire) lands transcript + artifact and reports back", async () => {
	const res = await post("/routines/run", {
		schema_version: 1,
		agent: "runner",
		slug: "routine-recap",
		name: "Recap",
		prompt: "Summarize last week's pipeline movement",
	});
	expect(res.status).toBe(200);
	const ran = (await res.json()) as { status: string; digest: string; session_id: string };
	expect(ran.status).toBe("ok");
	expect(ran.digest).toBeTruthy();
	expect(ran.session_id).toBeTruthy();
	// Transcript persisted into the routine's pi session.
	const session = (await (await fetch(`${base}/sessions/${ran.session_id}?agent=runner`)).json()) as {
		session: SessionMeta;
		messages: SessionMessage[];
	};
	expect(session.session.kind).toBe("routine");
	expect(session.messages.map((m) => m.from)).toEqual(["you", "nex"]);
	expect(session.messages[0].body).toBe("(scheduled) Summarize last week's pipeline movement");
	// The authored tool was persisted, and the run artifact saved.
	const tools = (await (await fetch(`${base}/tools?agent=runner`)).json()) as { tools: StoredTool[] };
	expect(tools.tools.map((t) => t.name)).toEqual(["weeklySummary"]);
	const arts = (await (await fetch(`${base}/artifacts?agent=runner`)).json()) as { artifacts: StoredArtifact[] };
	expect(arts.artifacts).toEqual([expect.objectContaining({ type: "md", title: "recap-run-1.md", producedBy: "Recap" })]);

	// A second fire for the SAME slug reuses the session (one thread per routine).
	const res2 = await post("/routines/run", {
		schema_version: 1,
		agent: "runner",
		slug: "routine-recap",
		name: "Recap",
		prompt: "Summarize last week's pipeline movement",
	});
	const ran2 = (await res2.json()) as { session_id: string };
	expect(ran2.session_id).toBe(ran.session_id);
});

test("manual sessions: default Chat <n> titles, transcript append, 404s", async () => {
	const s1 = (await (await post("/sessions", { schema_version: 1, agent: "chatter" })).json()) as { session: SessionMeta };
	expect(s1.session).toMatchObject({ kind: "manual", title: "Chat 1", agent: "chatter" });
	const s2 = (await (await post("/sessions", { schema_version: 1, agent: "chatter", title: "Named" })).json()) as { session: SessionMeta };
	expect(s2.session.title).toBe("Named");
	// Append-only transcript mirroring (FE chat stays client-side for now).
	const m1 = await post(`/sessions/${s1.session.id}/message`, { schema_version: 1, agent: "chatter", from: "you", body: "hi" });
	expect(((await m1.json()) as { ok: boolean }).ok).toBe(true);
	await post(`/sessions/${s1.session.id}/message`, { schema_version: 1, agent: "chatter", from: "nex", body: "hello" });
	const got = (await (await fetch(`${base}/sessions/${s1.session.id}?agent=chatter`)).json()) as { messages: SessionMessage[] };
	expect(got.messages.map((m) => `${m.from}:${m.body}`)).toEqual(["you:hi", "nex:hello"]);
	// Both sessions list (s2 is live-but-unflushed until its first exchange).
	const listed = (await (await fetch(`${base}/sessions?agent=chatter`)).json()) as { sessions: SessionMeta[] };
	expect(listed.sessions.map((s) => s.id).sort()).toEqual([s1.session.id, s2.session.id].sort());
	// 404s: unknown session for both GET and message-append.
	expect((await fetch(`${base}/sessions/ghost?agent=chatter`)).status).toBe(404);
	expect((await post("/sessions/ghost/message", { schema_version: 1, agent: "chatter", from: "you", body: "x" })).status).toBe(404);
});

test("validation ladder: bad JSON, bad shape, schema mismatch, missing agent", async () => {
	// JSON parse guard.
	const notJson = await fetch(`${base}/routines/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
	expect(notJson.status).toBe(400);
	// Shape guard: null/array/missing fields.
	for (const bad of [null, [], {}, { agent: "a" }, { agent: "a", slug: "s", name: "n" }]) {
		expect((await post("/routines/run", bad)).status).toBe(400);
	}
	// Path-traversal-shaped agent ids are rejected at the boundary.
	expect((await post("/routines/run", { schema_version: 1, agent: "..", slug: "s", name: "n", prompt: "p" })).status).toBe(400);
	// schema_version guard.
	expect((await post("/routines/run", { schema_version: 99, agent: "a", slug: "s", name: "n", prompt: "p" })).status).toBe(400);
	expect((await post("/sessions", { schema_version: 99, agent: "a" })).status).toBe(400);
	// Message shape guard.
	expect((await post("/sessions/x/message", { schema_version: 1, agent: "a", from: "them", body: "x" })).status).toBe(400);
	expect((await post("/sessions/x/message", { schema_version: 1, agent: "a", from: "you" })).status).toBe(400);
	// GET routes require a usable agent param.
	for (const path of ["/tools", "/sessions", "/artifacts", "/tools?agent=..", "/sessions?agent=%20"]) {
		expect((await fetch(`${base}${path}`)).status).toBe(400);
	}
});

test("POST /tools/build recovers from a corrupt app file instead of 500ing (HIGH-2)", async () => {
	// QA repro: a torn/corrupt per-agent store file made the store throw, so
	// /tools/build 500'd and the FE (buildToolFromChat) fell back to offline.
	// Pre-fix this is 500; post-fix the corrupt file is quarantined and the build
	// succeeds. Message mirrors the reported one ("<name> — <instruction>").
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, "app_torn.json"), "{ corrupt, not json");
	const res = await post("/tools/build", {
		schema_version: 1,
		message: "postHandoffToSlack — Post the lead, score, and reason to #ae-handoffs.",
		app: "app_torn",
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { tool: StoredTool };
	expect(body.tool.name).toBeTruthy();
	expect(body.tool.version).toBe(1); // fresh file after quarantine
	const listed = (await (await fetch(`${base}/tools?agent=app_torn`)).json()) as { tools: StoredTool[] };
	expect(listed.tools).toHaveLength(1);
});

test("GET routes read empty for an unknown agent (no 500s from a missing file)", async () => {
	expect(((await (await fetch(`${base}/tools?agent=nobody`)).json()) as { tools: unknown[] }).tools).toEqual([]);
	expect(((await (await fetch(`${base}/sessions?agent=nobody`)).json()) as { sessions: unknown[] }).sessions).toEqual([]);
	expect(((await (await fetch(`${base}/artifacts?agent=nobody`)).json()) as { artifacts: unknown[] }).artifacts).toEqual([]);
});
