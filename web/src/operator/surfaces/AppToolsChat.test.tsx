import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A model-authored /tools/build answer — the only way a taught tool may land
 * in the Tools tab (stub/offline answers must refuse honestly instead). */
function builtTool(name: string, title: string) {
  return {
    ok: true,
    json: async () => ({
      tool: {
        name,
        title,
        purpose: `${title} for the pipeline`,
        inputs: [],
        code: `function ${name}() { return "ok"; }`,
      },
      narration: `Built ${title}.`,
      authored_by: "model",
    }),
  };
}

import { authorToolFromDescription } from "../tools/mockTools";
import { ToolsProvider } from "../tools/toolsContext";
import { AppToolsChat } from "./AppToolsChat";
import { AppToolsTab } from "./AppToolsTab";

// Slice 2: teaching a workflow in the app's chat calls create_tool; the tool-call
// renders in the chat AND the new tool appears in the shared Tools tab.
// The provider seeds NOTHING in product code (agents start with no tools), so
// these tests seed their fixture toolbox explicitly through the test seam.
function fixtureTools() {
  return [
    authorToolFromDescription("Every Monday, summarize last week's pipeline"),
    authorToolFromDescription(
      "When a new lead comes in, score its fit and route hot ones to the right AE",
    ),
  ];
}

function renderApp() {
  return render(
    <ToolsProvider appName="Pipeline" initialTools={fixtureTools()}>
      <AppToolsChat appName="Pipeline" />
      <AppToolsTab appName="Pipeline" />
    </ToolsProvider>,
  );
}

describe("AppToolsChat + Tools tab (slice 2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("teaching a workflow calls create_tool and the tool lands in the tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          builtTool("draftFollowup", "Draft a follow-up email"),
        ),
    );
    const { getByLabelText, getByText, findByText, queryByText } = renderApp();

    // Seeded tools are already listed; the new one is not there yet.
    expect(getByText("Weekly pipeline summary")).toBeTruthy();
    expect(queryByText("Draft a follow-up email")).toBeNull();

    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "Draft a follow-up email for a stalled deal" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    // The chat renders the agent's create_tool call…
    const call = await findByText(/create_tool\(/);
    expect(call.textContent).toContain('name: "draftFollowup"');

    // …and the new tool now appears in the Tools tab (shared context).
    await waitFor(() =>
      expect(getByText("Draft a follow-up email")).toBeTruthy(),
    );
  });

  // 2026-08-15 QA regression: a teach that the service could not really author
  // must never mint a tool — not from the offline mock, not from the service's
  // canned stub. The chat says what happened instead.
  it("refuses honestly when the service is unreachable (no mock tool)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("agent down")));
    const { getByLabelText, findByText, queryByText } = renderApp();
    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "Draft a follow-up email for a stalled deal" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await findByText(/could not reach the tool-building service/i),
    ).toBeTruthy();
    expect(queryByText("Draft a follow-up email")).toBeNull();
  });

  it("refuses honestly when the service stub-authored (no canned tool)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tool: {
            name: "draftBoardUpdate",
            title: "Draft a board update",
            purpose: "canned",
            inputs: [],
            code: "function draftBoardUpdate() {}",
          },
          narration: "Built Draft a board update.",
          authored_by: "stub",
        }),
      }),
    );
    const { getByLabelText, findByText, queryByText } = renderApp();
    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "score each workspace task for hygiene risk" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await findByText(/no AI model connected/i)).toBeTruthy();
    // The canned stub tool must NOT land in the Tools tab.
    expect(queryByText("Draft a board update")).toBeNull();
  });

  it("re-teaching the same workflow updates the tool in place (no duplicate)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          builtTool("scoreAndRouteLead", "Score & route a lead"),
        ),
    );
    const { getByLabelText, findAllByText } = renderApp();
    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;

    for (let i = 0; i < 2; i++) {
      fireEvent.change(input, {
        target: { value: "score the lead and route it" },
      });
      fireEvent.keyDown(input, { key: "Enter" });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(input.disabled).toBe(false));
    }

    // scoreAndRouteLead was seeded AND taught twice, but the tab shows one card
    // (dedup by name). The chat, however, shows a call each time.
    const cards = await findAllByText("Score & route a lead");
    expect(cards).toHaveLength(1);
  });
});

// Slice 5: the chat CALLS existing tools via the agent's /tools/call (no Run
// button anywhere); a gated result pauses on an inline approval card.
describe("AppToolsChat calls tools (slice 5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(data: unknown) {
    return { ok: true, json: async () => data };
  }

  it('"run the weekly summary" calls the tool, shows the result, and logs the call', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        result: "4 items — Globex, Acme (simulated recap)",
        actions: ['crm.deals({"since":"7d"})', "nex.ai.summarize([…])"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, findByText, findAllByText } = renderApp();
    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "run the weekly summary" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The chat renders the tool call and what the tool did…
    const call = await findByText(/weeklyPipelineSummary\(\)/);
    expect(call).toBeTruthy();
    expect(await findByText('crm.deals({"since":"7d"})')).toBeTruthy();

    // …the result shows in the chat AND as the tab's read-only "Last run".
    const results = await findAllByText(
      "4 items — Globex, Acme (simulated recap)",
    );
    expect(results).toHaveLength(2);
    expect(await findByText(/Last run/)).toBeTruthy();

    // It called the agent, and did not fall back to any mock execution.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.tool.name).toBe("weeklyPipelineSummary");
    expect(body.approved).toBe(false);
  });

  it("a gated result pauses on the approval card; Approve completes the call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "needs_approval",
          gate: {
            capability: "crm.assign",
            detail: "assign Acme to Priya (AE)",
          },
          actions: ['nex.ai.score("Acme")'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          result: "Fit 82 → routed to Priya (AE)",
          actions: ['nex.ai.score("Acme")', 'crm.assign("Acme", …)'],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, findByText, findAllByText } = renderApp();
    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'use Score & route a lead on "Acme"' },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    // Paused: the inline approval card renders with the gate detail.
    expect(
      await findByText(/This will assign Acme to Priya \(AE\)\. Send it\?/),
    ).toBeTruthy();

    // Approve re-calls with approved: true and renders the completed call.
    fireEvent.click(await findByText("Approve"));
    const done = await findAllByText("Fit 82 → routed to Priya (AE)");
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(second.approved).toBe(true);
    expect(second.args).toEqual({ lead: "Acme" });
  });

  it("a bare mention of a tool teaches — it does not auto-invoke — and re-teaching keeps run history", async () => {
    const fetchMock = vi
      .fn()
      // 1st message runs the tool (explicit cue) so it has history…
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          result: "4 items — Globex, Acme (simulated recap)",
          actions: [],
        }),
      )
      // …2nd message teaches via the service (model-authored).
      .mockResolvedValueOnce(
        builtTool("weeklyPipelineSummary", "Weekly pipeline summary"),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, findByText } = renderApp();
    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "run the weekly summary" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await findByText(/Last run/)).toBeTruthy();

    // A modify hand-off that MENTIONS the tool's title but has no run/call/use
    // cue must TEACH (create_tool), never re-run the tool.
    fireEvent.change(input, {
      target: {
        value: "Update the weekly pipeline summary to include churned deals",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    const call = await findByText(/create_tool\(/);
    expect(call.textContent).toContain('name: "weeklyPipelineSummary"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/agent/tools/build");

    // Re-teaching replaced the tool by name but kept its run history.
    expect(await findByText(/Last run/)).toBeTruthy();
  });

  // 2026-08-15 QA regression: a run with no explicit input values must ASK,
  // never invoke on leftover command text (garbage args crashed real tools).
  it("asks for missing inputs, then runs with the answered value", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        result: "drafted the follow-up",
        actions: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, findByText, findAllByText } = renderApp();
    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;
    // scoreAndRouteLead takes a `lead` input; "run ..." gives no explicit value.
    fireEvent.change(input, {
      target: { value: "run score and route a lead" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await findByText(/I need `lead`/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    // The next message answers; a single missing input takes the whole text.
    fireEvent.change(input, { target: { value: "Globex renewal" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await findAllByText("drafted the follow-up")).length).toBeGreaterThan(0);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.args).toEqual({ lead: "Globex renewal" });
  });

  it('"Not now" skips the gated call without re-calling the agent', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        status: "needs_approval",
        gate: { capability: "nex.send", detail: "send it to #sales" },
        actions: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, findByText } = renderApp();
    const input = getByLabelText(
      "Describe a task for Nex to build a tool for",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "run the weekly summary" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(await findByText("Not now"));
    expect(
      await findByText("Okay — I didn't send it. Nothing left this agent."),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
