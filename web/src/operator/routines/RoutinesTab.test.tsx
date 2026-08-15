import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutinesTab } from "./RoutinesTab";

describe("RoutinesTab", () => {
  /** Adds a routine through the form (the only source now — no seeds). */
  function addRoutine(utils: ReturnType<typeof render>, prompt: string): void {
    fireEvent.change(utils.getByLabelText("Routine prompt"), {
      target: { value: prompt },
    });
    fireEvent.click(utils.getByText("Add routine"));
  }

  it("starts empty with an honest empty note — no fabricated seeds", () => {
    const { getByText, queryByText } = render(
      <RoutinesTab agentName="Pipeline Agent" />,
    );
    expect(getByText(/No routines yet/)).toBeTruthy();
    // 2026-08-15 audit regression: the fabricated seeds must never render.
    expect(queryByText("Monday pipeline recap")).toBeNull();
    expect(queryByText("Route new leads")).toBeNull();
  });

  it("disables one routine without touching the others", () => {
    const utils = render(<RoutinesTab agentName="Pipeline Agent" />);
    addRoutine(utils, "Recap the pipeline every Monday");
    addRoutine(utils, "Chase stalled deals");
    const disables = utils.getAllByText("Disable");
    expect(disables.length).toBe(2);
    fireEvent.click(disables[0]);
    expect(utils.getAllByText("Disable").length).toBe(1);
    expect(utils.getAllByText("Enable").length).toBe(1);
  });

  it("editing a prompt marks a draft; Publish freezes it as the next version", () => {
    const utils = render(<RoutinesTab agentName="Pipeline Agent" />);
    addRoutine(utils, "Recap the pipeline every Monday");
    const prompt = utils.getAllByLabelText(
      /Prompt for/,
    )[0] as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "New sharper prompt" } });
    expect(utils.getByText(/v1 · draft/)).toBeTruthy();
    fireEvent.click(utils.getAllByText("Publish new version")[0]);
    expect(utils.getByText(/v2$/)).toBeTruthy();
  });

  it("adds a new routine from a prompt + schedule", () => {
    const { getByLabelText, getByText, getAllByText } = render(
      <RoutinesTab agentName="Pipeline Agent" />,
    );
    fireEvent.change(getByLabelText("Routine prompt"), {
      target: { value: "Email me anything stuck in legal" },
    });
    fireEvent.click(getByText("Add routine"));
    // The new routine renders (name span + editable prompt).
    expect(
      getAllByText("Email me anything stuck in legal").length,
    ).toBeGreaterThan(0);
  });

  it("opens the routine's chat session", () => {
    const onOpenSession = vi.fn();
    const utils = render(
      <RoutinesTab agentName="Pipeline Agent" onOpenSession={onOpenSession} />,
    );
    addRoutine(utils, "Recap the pipeline every Monday");
    fireEvent.click(utils.getAllByText("Open its chat")[0]);
    expect(onOpenSession).toHaveBeenCalledWith(
      expect.stringMatching(/^sess/),
      "Recap the pipeline every Monday",
    );
  });
});

// With a REAL agent id a routine IS a broker scheduler job (via /api): cron,
// enable/disable, revisions (versioning), and run history live there. When the
// broker is unreachable the tab says so — it never fabricates rows.
describe("RoutinesTab (live broker scheduler)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Raw broker scheduler job as GET /api/scheduler returns it.
  function job(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      slug: "routine-live-recap",
      label: "Live recap",
      target_type: "agent",
      target_id: "app_x",
      schedule_expr: "0 9 * * 1",
      payload: "Summarize the pipeline",
      enabled: true,
      status: "scheduled",
      ...over,
    };
  }

  function ok(data: unknown) {
    return { ok: true, json: async () => data };
  }

  /** Routes the broker endpoints the routine view touches. */
  function brokerFetch(overrides: {
    onPatch?: () => unknown;
    onCreate?: () => unknown;
    jobs?: () => unknown[];
    runs?: () => unknown[];
  }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return ok({ job: overrides.onPatch?.() ?? job() });
      }
      if (url === "/api/scheduler/routines" && init?.method === "POST") {
        return ok({ job: overrides.onCreate?.() ?? job() });
      }
      if (url.endsWith("/run") && init?.method === "POST") {
        return ok({ job: job() });
      }
      if (url.endsWith("/revisions")) {
        return ok({
          revisions: [
            { version: 2, created_at: "", label: "Live recap", enabled: true },
          ],
        });
      }
      if (url.endsWith("/runs")) {
        return ok({ runs: overrides.runs?.() ?? [] });
      }
      return ok({ jobs: overrides.jobs?.() ?? [job()] });
    });
  }

  it("loads routines from the broker scheduler for a real agent id", async () => {
    const fetchMock = brokerFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, queryByText, getByText, getAllByText } = render(
      <RoutinesTab agentName="Pipeline Agent" agentId="app_x" />,
    );
    expect(await findByText("Live recap")).toBeTruthy();
    expect(queryByText("Monday pipeline recap")).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/scheduler");
    // Version comes from the revision history; cron renders as its label
    // (the row's schedule chip; the label also exists as a select preset).
    expect(getByText(/v2/)).toBeTruthy();
    expect(getAllByText("Every Monday 9:00").length).toBeGreaterThan(1);
  });

  it("says routines are unavailable when the broker is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("broker down"));
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, queryByText } = render(
      <RoutinesTab agentName="Pipeline Agent" agentId="app_x" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Honest note, no fabricated rows.
    expect(await findByText(/Routines are unavailable right now/)).toBeTruthy();
    expect(queryByText("Monday pipeline recap")).toBeNull();
  });

  it("Disable PATCHes the scheduler job and renders the broker's answer", async () => {
    const fetchMock = brokerFetch({ onPatch: () => job({ enabled: false }) });
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByText } = render(
      <RoutinesTab agentName="Pipeline Agent" agentId="app_x" />,
    );
    await findByText("Live recap"); // hydration replaced the seeds
    fireEvent.click(getByText("Disable"));
    expect(await findByText("paused")).toBeTruthy();
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(patchCall?.[0]).toBe("/api/scheduler/routine-live-recap");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      enabled: false,
    });
  });

  it("Publish sends the edited prompt as a broker revision with a change note", async () => {
    const fetchMock = brokerFetch({
      onPatch: () => job({ payload: "New sharper prompt" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getAllByLabelText, getAllByText } = render(
      <RoutinesTab agentName="Pipeline Agent" agentId="app_x" />,
    );
    await findByText("Live recap");
    const prompt = getAllByLabelText(/Prompt for/)[0] as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "New sharper prompt" } });
    fireEvent.click(getAllByText("Publish new version")[0]);
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "PATCH",
      );
      expect(patchCall?.[0]).toBe("/api/scheduler/routine-live-recap");
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
        payload: "New sharper prompt",
        change_note: "Published from the Routines tab",
      });
    });
  });

  it("Run now queues a broker fire and says so", async () => {
    const fetchMock = brokerFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByText } = render(
      <RoutinesTab agentName="Pipeline Agent" agentId="app_x" />,
    );
    await findByText("Live recap"); // hydration replaced the seeds
    fireEvent.click(getByText("Run now"));
    expect(await findByText("queued — starting in a moment")).toBeTruthy();
    const runCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/run"),
    );
    expect(runCall?.[0]).toBe("/api/scheduler/routine-live-recap/run");
  });

  it("Add routine registers a scheduler routine (purpose + cron + owner)", async () => {
    const fetchMock = brokerFetch({
      onCreate: () =>
        job({
          slug: "routine-chase-legal",
          label: "Chase legal",
          payload: "Email me anything stuck in legal",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByLabelText, getByText } = render(
      <RoutinesTab agentName="Pipeline Agent" agentId="app_x" />,
    );
    await findByText("Live recap");
    fireEvent.change(getByLabelText("Routine prompt"), {
      target: { value: "Email me anything stuck in legal" },
    });
    fireEvent.click(getByText("Add routine"));
    expect(await findByText("Chase legal")).toBeTruthy();
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/scheduler/routines" && init?.method === "POST",
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      purpose: "Email me anything stuck in legal".slice(0, 40),
      schedule: "0 9 * * 1",
      prompt: "Email me anything stuck in legal",
      owner: "app_x",
      created_by: "operator",
    });
  });

  it("expands Recent runs and lists the routine's run history (first line only)", async () => {
    const fetchMock = brokerFetch({
      runs: () => [
        {
          slug: "routine-live-recap",
          started_at: "2026-07-02T09:02:00Z",
          status: "ok",
          output_summary: "Recap saved to Artifacts.\nFull detail below.",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByText, queryByText } = render(
      <RoutinesTab agentName="Pipeline Agent" agentId="app_x" />,
    );
    await findByText("Live recap");
    // Runs load lazily: nothing fetched until the disclosure is expanded.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/runs")),
    ).toBe(false);
    fireEvent.click(getByText("Recent runs"));
    expect(await findByText("Recap saved to Artifacts.")).toBeTruthy();
    // Only the first summary line is shown, not the whole thing.
    expect(queryByText("Full detail below.")).toBeNull();
    const runsCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/runs"),
    );
    expect(runsCall?.[0]).toBe("/api/scheduler/routine-live-recap/runs");
  });
});
