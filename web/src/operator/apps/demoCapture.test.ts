import { describe, expect, it } from "vitest";

import {
  capturePromptSeed,
  type DemoCaptureLine,
  demoCaptureFromDraft,
} from "./demoCapture";

// A realistic real-call draft (what the realtime model reports back) — the only
// capture source now that the scripted example no longer fabricates one.
const BUILD_DRAFT = {
  goal: "When a demo request comes in, look up the company and route hot leads to an AE.",
  summary: "Drafted a lead-routing agent",
  screens: [{ label: "HubSpot — Inbound demo requests" }],
  selectors: [{ label: "Lead row", role: "button", selector: ".lead-row" }],
  apiCalls: [
    {
      method: "get",
      endpoint: "/crm/v3/objects/companies",
      integration: "HubSpot",
    },
    { method: "post", endpoint: "/api/chat.postMessage", integration: "Slack" },
  ],
  entities: [{ kind: "channel", value: "#ae-handoffs" }],
};

const BUILD_TRANSCRIPT: DemoCaptureLine[] = [
  { who: "ai", text: "Walk me through it." },
  { who: "you", text: "A request comes into this form." },
  { who: "ai", text: "Got it. I've drafted a tool. Want to see it?" },
];

const MODIFY_TRANSCRIPT: DemoCaptureLine[] = [
  { who: "ai", text: "Show me the change." },
  { who: "you", text: "Archive anything under 40." },
  { who: "ai", text: "Got it. I've drafted the change. Want to see it?" },
];

describe("capturePromptSeed", () => {
  it("leads with the goal and appends the captured apps + APIs", () => {
    const capture = demoCaptureFromDraft(BUILD_DRAFT, {
      mode: "build",
      transcript: BUILD_TRANSCRIPT,
    });
    const seed = capturePromptSeed(capture);

    // Leads with the goal, then carries the observed apps/APIs and the FULL
    // transcript so the build works from the real session, not a summary.
    expect(seed.startsWith(capture.goal)).toBe(true);
    expect(seed).toMatch(/HubSpot/);
    expect(seed).toMatch(/Slack/);
    expect(seed).toMatch(/captured from the screen share/i);
    expect(seed).toMatch(/Full transcript of the demo call/i);
    expect(seed).toMatch(/Operator: A request comes into this form\./);
  });

  it("carries the goal, key details, and transcript even with no API calls", () => {
    const capture = demoCaptureFromDraft(
      {
        goal: "Archive anything under 40 instead of nurturing it.",
        summary: "Drafted the change",
        entities: [{ kind: "threshold", value: "scores under 40" }],
      },
      {
        mode: "modify",
        tool: { id: "inbound-routing", name: "Inbound routing" },
        transcript: MODIFY_TRANSCRIPT,
      },
    );
    const seed = capturePromptSeed(capture);
    expect(seed.startsWith(capture.goal)).toBe(true);
    // The modify scenario has no sniffed API calls but still has entities + the
    // transcript, so the seed is far more than the bare goal.
    expect(seed).not.toBe(capture.goal);
    expect(seed).toMatch(/Key details:/);
    expect(seed).toMatch(/Operator: Archive anything under 40\./);
  });

  it("includes the real page structure cua read (the ground-truth section)", () => {
    const capture = {
      ...demoCaptureFromDraft(BUILD_DRAFT, {
        mode: "build",
        transcript: BUILD_TRANSCRIPT,
      }),
      observed: [
        {
          app: "Google Chrome",
          title: "HubSpot — Acme Robotics",
          components: [
            { role: "TextField", label: "Company search" },
            { role: "Button", label: "Search" },
          ],
          text: "200+ employees · Robotics",
        },
      ],
    };
    const seed = capturePromptSeed(capture);
    expect(seed).toMatch(/Real page structure Nex read/i);
    expect(seed).toMatch(/Google Chrome — HubSpot — Acme Robotics/);
    expect(seed).toMatch(/TextField:Company search/);
    expect(seed).toMatch(/200\+ employees/);
  });
});

describe("demoCaptureFromDraft (real-call converter)", () => {
  it("coerces loose model output into the typed capture and drops empties", () => {
    const capture = demoCaptureFromDraft(
      {
        goal: "  Route urgent tickets to the on-call engineer  ",
        summary: "Drafted a routing tool",
        screens: [{ label: "Zendesk" }, { label: "" }],
        selectors: [
          { label: "Priority field", role: "DROPDOWN", selector: "#prio" },
          { label: "no selector", selector: "" },
        ],
        apiCalls: [
          {
            method: "post",
            endpoint: "/api/v2/tickets",
            integration: "Zendesk",
          },
          { endpoint: "" },
        ],
        entities: [{ kind: "Channel", value: "#oncall" }, { value: "" }],
      },
      { mode: "build", transcript: [] },
    );

    expect(capture.goal).toBe("Route urgent tickets to the on-call engineer");
    // Empty-label screen, selector-less element, endpoint-less call, and
    // value-less entity are all dropped.
    expect(capture.screens).toHaveLength(1);
    expect(capture.selectors).toHaveLength(1);
    expect(capture.apiCalls).toHaveLength(1);
    expect(capture.entities).toHaveLength(1);
    // Unknown role/kind coerce to safe defaults; method upper-cases.
    expect(capture.selectors[0].role).toBe("input");
    expect(capture.apiCalls[0].method).toBe("POST");
    expect(capture.entities[0].kind).toBe("channel");
  });

  it("carries the tool identity in modify mode", () => {
    const capture = demoCaptureFromDraft(
      { goal: "Archive under 40" },
      {
        mode: "modify",
        tool: { id: "inbound-routing", name: "Inbound routing" },
        transcript: [{ who: "you", text: "archive them" }],
      },
    );
    expect(capture.mode).toBe("modify");
    expect(capture.toolId).toBe("inbound-routing");
    expect(capture.transcript).toHaveLength(1);
  });
});

describe("demo intent (kind / routine / tools)", () => {
  it("coerces the drafted kind, routine, and tools with safe defaults", () => {
    const capture = demoCaptureFromDraft(
      {
        goal: "Recap the pipeline every Monday.",
        kind: "ROUTINE",
        routine: { prompt: "Summarize last week's pipeline." },
        tools: [
          { name: "summarizePipeline", purpose: "Read deals and recap moves." },
          { name: "", purpose: "dropped — no name" },
        ],
      },
      { mode: "build", transcript: [] },
    );
    expect(capture.kind).toBe("routine");
    // Name and schedule default; the prompt is what makes a routine runnable.
    expect(capture.routine).toEqual({
      name: "Scheduled routine",
      prompt: "Summarize last week's pipeline.",
      schedule: "daily",
    });
    expect(capture.tools).toEqual([
      { name: "summarizePipeline", purpose: "Read deals and recap moves." },
    ]);
  });

  it("defaults to an app build and drops a promptless routine", () => {
    const capture = demoCaptureFromDraft(
      { goal: "A screen to review refunds.", routine: { name: "no prompt" } },
      { mode: "build", transcript: [] },
    );
    expect(capture.kind).toBe("app");
    expect(capture.routine).toBeUndefined();
    expect(capture.tools).toEqual([]);
  });

  it("seeds the build with the intent, the routine, and the needed tools", () => {
    const capture = demoCaptureFromDraft(
      {
        goal: "Recap the pipeline every Monday.",
        kind: "both",
        routine: {
          name: "Monday recap",
          prompt: "Summarize last week's pipeline.",
          schedule: "0 9 * * 1",
        },
        tools: [
          { name: "summarizePipeline", purpose: "Read deals and recap moves." },
        ],
      },
      { mode: "build", transcript: [] },
    );
    const seed = capturePromptSeed(capture);
    expect(seed).toMatch(/What to build: .*BOTH/);
    expect(seed).toContain('"Monday recap" — runs 0 9 * * 1');
    expect(seed).toContain("summarizePipeline (Read deals and recap moves.)");
  });
});
