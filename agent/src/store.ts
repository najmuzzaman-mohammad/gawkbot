// File-backed per-agent persistence: tools and artifacts, one JSON file per
// agent id under a data dir. Chat sessions live in pi's own session format
// (sessions.ts / PiSessions); routines live in the BROKER's scheduler registry
// (cron, revisions, run history) — neither is stored here.
//
//   - Data dir: WUPHF_AGENT_DATA_DIR, default agent/.wuphf-agent-data/ relative
//     to this package. Created lazily on first save.
//   - Writes are atomic-ish: write a UNIQUE <file>.<pid>.<rand>.tmp, then rename
//     over the target. The temp name is per-write so two concurrent writers (e.g.
//     two service instances sharing WUPHF_AGENT_DATA_DIR) never scribble over one
//     shared temp and rename a torn file into place.
//   - Agent ids are sanitized into safe filenames (path separators and other
//     unsafe characters normalize to "_"; empty / dot-only ids are rejected).
//   - A missing file reads as the empty shape. A CORRUPT file is QUARANTINED
//     (renamed to <file>.corrupt-<ts>) and read as empty: the operator's tool
//     authoring recovers instead of dead-ending in an opaque 500 (which the FE
//     shows as "offline"), and the unparseable bytes are preserved for recovery
//     rather than clobbered on the next save.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredArtifact, StoredTool, Tool } from "./wire.js";

export interface AgentData {
	tools: StoredTool[];
	artifacts: StoredArtifact[];
}

const PACKAGE_DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".wuphf-agent-data");

export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
	return env.WUPHF_AGENT_DATA_DIR?.trim() || PACKAGE_DEFAULT_DIR;
}

/** Normalize an agent id into a safe filename stem. Rejects ids that would
 * escape the data dir (path separators normalize to "_"; "."/".."/empty throw). */
export function sanitizeAgentId(agent: string): string {
	const safe = agent.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
	if (!safe || /^\.+$/.test(safe)) throw new Error(`invalid agent id: ${JSON.stringify(agent)}`);
	return safe;
}

function emptyData(): AgentData {
	return { tools: [], artifacts: [] };
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function isEnoent(e: unknown): boolean {
	return e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT";
}

export class AgentStore {
	constructor(private readonly dir: string = defaultDataDir()) {}

	private fileFor(agent: string): string {
		return join(this.dir, `${sanitizeAgentId(agent)}.json`);
	}

	/** Every agent id with a data file (used by the scheduler's sweep). */
	agents(): string[] {
		try {
			return readdirSync(this.dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -".json".length));
		} catch (e) {
			if (isEnoent(e)) return []; // data dir not created yet
			throw e;
		}
	}

	load(agent: string): AgentData {
		const file = this.fileFor(agent);
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch (e) {
			if (isEnoent(e)) return emptyData();
			throw e; // a transient read error (EACCES etc.) must NOT quarantine good data
		}
		let parsed: Partial<AgentData>;
		try {
			parsed = JSON.parse(raw) as Partial<AgentData>;
		} catch {
			// Corrupt JSON (e.g. a torn write from a pre-fix concurrent writer): move
			// it aside so this agent's authoring recovers on the next save instead of
			// every store-backed request 500ing. The bytes survive under the quarantine
			// name for manual recovery — we never clobber them in place.
			this.quarantine(file);
			return emptyData();
		}
		// Tolerate older/partial files: missing sections read as empty (a file
		// from the pre-rework store may also carry routines/sessions keys —
		// ignored here; the broker and pi sessions own those now).
		return {
			tools: Array.isArray(parsed.tools) ? parsed.tools : [],
			artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
		};
	}

	/** Rename an unparseable data file aside so it stops wedging reads, keeping the
	 * bytes for recovery. Best-effort: a failure here must not mask the original. */
	private quarantine(file: string): void {
		try {
			renameSync(file, `${file}.corrupt-${Date.now()}`);
		} catch {
			// If we cannot move it aside, fall through — the next save overwrites the
			// target, which is still better than a permanently 500ing agent.
		}
	}

	save(agent: string, data: AgentData): void {
		mkdirSync(this.dir, { recursive: true }); // lazy dir creation
		const file = this.fileFor(agent);
		// Unique temp per write: concurrent writers each own their temp, so a rename
		// only ever publishes a fully-written file — no torn bytes reach the target.
		const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2));
		renameSync(tmp, file); // atomic-ish: readers never see a half-written file
	}

	// -------------------------------------------------------------------------
	// Tools
	// -------------------------------------------------------------------------

	listTools(agent: string): StoredTool[] {
		return this.load(agent).tools;
	}

	/** The agent's persisted tool with this name, or null. Execution paths MUST
	 * resolve code through here — never run code supplied in a request body. */
	getTool(agent: string, name: string): StoredTool | null {
		return this.load(agent).tools.find((t) => t.name === name) ?? null;
	}

	/** Persist an authored tool. A same-named tool is replaced with version+1. */
	upsertTool(agent: string, tool: Tool): StoredTool {
		const data = this.load(agent);
		const existing = data.tools.find((t) => t.name === tool.name);
		const stored: StoredTool = { ...tool, version: existing ? existing.version + 1 : 1 };
		const tools = existing ? data.tools.map((t) => (t.name === tool.name ? stored : t)) : [...data.tools, stored];
		this.save(agent, { ...data, tools });
		return stored;
	}

	// -------------------------------------------------------------------------
	// Artifacts
	// -------------------------------------------------------------------------

	listArtifacts(agent: string): StoredArtifact[] {
		return this.load(agent).artifacts;
	}

	addArtifact(agent: string, artifact: Omit<StoredArtifact, "id" | "at">, now: Date = new Date()): StoredArtifact {
		const data = this.load(agent);
		const stored: StoredArtifact = { ...artifact, id: newId("art"), at: now.toISOString() };
		this.save(agent, { ...data, artifacts: [...data.artifacts, stored] });
		return stored;
	}
}
