import { describe, expect, it } from "vitest";

import {
  authorToolFromDescription,
  callTool,
  sampleArgsFor,
  seedToolsForApp,
} from "./mockTools";

describe("authorToolFromDescription", () => {
  it("recognizes the score-and-flag workflow with a plain title", () => {
    const t = authorToolFromDescription(
      "When a new record comes in, score and triage it by risk",
    );
    expect(t.name).toBe("scoreAndFlag");
    expect(t.title).toBe("Score & flag records");
    expect(t.inputs.map((i) => i.name)).toEqual(["rubric"]);
    expect(t.script).toContain("async function scoreAndFlag(rubric)");
    expect(t.createdFrom).toContain("score and triage");
  });

  it("derives a plain-language title for an unknown workflow", () => {
    // Leading "When … ," trigger is dropped so the title names the action.
    const t = authorToolFromDescription(
      "When an invoice arrives, file it in the folder",
    );
    expect(t.title).toBe("File it in the folder");
  });

  it("recognizes the weekly summary workflow", () => {
    const t = authorToolFromDescription("Every Monday summarize the week");
    expect(t.name).toBe("weeklySummary");
    expect(t.inputs).toEqual([]);
  });

  it("recognizes the message-draft workflow", () => {
    const t = authorToolFromDescription(
      "Draft a follow-up message for a record",
    );
    expect(t.name).toBe("draftMessage");
    expect(t.inputs.map((i) => i.name)).toEqual(["recordId"]);
  });

  it("synthesizes a camelCase name for an unknown workflow", () => {
    const t = authorToolFromDescription("Archive old records nightly");
    // Stopwords dropped, first three content words → camelCase.
    expect(t.name).toBe("archiveOldRecords");
    expect(t.inputs.map((i) => i.name)).toEqual(["input"]);
    expect(t.script).toContain("archiveOldRecords");
  });

  it("falls back to a safe name when the description is all stopwords", () => {
    const t = authorToolFromDescription("the a an my");
    expect(t.name).toBe("runWorkflow");
  });
});

describe("callTool", () => {
  it("returns the known shape's canned result", () => {
    const t = authorToolFromDescription("score and triage each record");
    const call = callTool(t, sampleArgsFor(t));
    expect(call.args).toEqual({ rubric: "priority" });
    expect(call.result).toMatch(/flagged/i);
  });

  it("echoes args for an unknown tool", () => {
    const t = authorToolFromDescription("archive old records");
    const call = callTool(t, { input: "2024" });
    expect(call.result).toContain(t.name);
    expect(call.result).toContain("2024");
  });
});

describe("seedToolsForApp", () => {
  it("seeds nothing — an agent shows only the tools actually taught to it", () => {
    expect(seedToolsForApp("Pipeline")).toEqual([]);
  });
});
