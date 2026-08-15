import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSessions } from "./AgentSessions";

// Stub the chat pane: AgentSessions owns the sessions strip + transcript
// hand-off; the chat itself is covered by AppToolsChat.test.tsx. The stub
// surfaces the initialTranscript it received and can emit a turn via onTurn.
vi.mock("../surfaces/AppToolsChat", () => ({
  AppToolsChat: ({
    initialTranscript,
    onTurn,
  }: {
    initialTranscript?: { from: "you" | "nex"; body: string }[];
    onTurn?: (from: "you" | "nex", body: string) => void;
  }) => (
    <div data-testid="chat-pane">
      <span data-testid="transcript">
        {(initialTranscript ?? []).map((m) => m.body).join(" | ")}
      </span>
      <button
        type="button"
        onClick={() => {
          onTurn?.("you", "hi agent");
          onTurn?.("nex", "hello operator");
        }}
      >
        emit turn
      </button>
    </div>
  ),
}));

function ok(data: unknown) {
  return { ok: true, json: async () => data };
}

const WIRE_SESSIONS = [
  {
    id: "s1",
    agent: "app_x",
    title: "Weekly recap run",
    kind: "routine",
    at: "Monday 9:02",
  },
  { id: "s2", agent: "app_x", title: "Chat", kind: "manual", at: "yesterday" },
];

const S1_MESSAGES = [
  { from: "you", body: "(scheduled) Weekly recap run", at: "Monday 9:02" },
  { from: "nex", body: "Recap saved to Artifacts.", at: "Monday 9:03" },
];

// Answers list/detail/create/message against the contract shapes.
function serviceFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/agent/sessions?agent=app_x") {
      return ok({ sessions: WIRE_SESSIONS });
    }
    if (url.startsWith("/agent/sessions/s1?")) {
      return ok({ session: WIRE_SESSIONS[0], messages: S1_MESSAGES });
    }
    if (url.startsWith("/agent/sessions/s2?")) {
      return ok({ session: WIRE_SESSIONS[1], messages: [] });
    }
    if (url === "/agent/sessions" && init?.method === "POST") {
      return ok({
        session: {
          id: "s9",
          agent: "app_x",
          title: "Chat 3",
          kind: "manual",
          at: "just now",
        },
      });
    }
    if (url.endsWith("/message") && init?.method === "POST") {
      return ok({ ok: true });
    }
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  });
}

describe("AgentSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with only the local draft chat — no fabricated history", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getByText, queryByText } = render(
      <AgentSessions agentName="Pipeline Agent" />,
    );
    expect(getByText("Chat with your agent")).toBeTruthy();
    // 2026-08-15 audit regression: the seeded fake sessions must never render.
    expect(queryByText("Monday pipeline recap")).toBeNull();
    expect(queryByText("Route new leads")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the draft chat usable and says why when the service is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("agent down"));
    vi.stubGlobal("fetch", fetchMock);
    const { getByText, findByText } = render(
      <AgentSessions agentName="Pipeline Agent" agentId="app_x" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(getByText("Chat with your agent")).toBeTruthy();
    expect(
      await findByText(/Past sessions are unavailable right now/),
    ).toBeTruthy();
  });

  it("hydrates sessions + the persisted transcript from the service", async () => {
    vi.stubGlobal("fetch", serviceFetch());
    // Explicitly open the routine session (as "Open its chat" would): the
    // DEFAULT now lands on a manual session, so request s1 to exercise routine
    // transcript hydration.
    const { findByText, getByTestId, queryByText } = render(
      <AgentSessions
        agentName="Pipeline Agent"
        agentId="app_x"
        requestedSessionId="s1"
      />,
    );
    expect(await findByText("Weekly recap run")).toBeTruthy();
    // The seeds were replaced by the service's sessions.
    expect(queryByText("Chat with your agent")).toBeNull();
    // The routine session's persisted messages reached the chat pane.
    await waitFor(() =>
      expect(getByTestId("transcript").textContent).toContain(
        "Recap saved to Artifacts.",
      ),
    );
  });

  it("mirrors chat turns to POST /sessions/<id>/message fire-and-forget", async () => {
    const fetchMock = serviceFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByTestId, getByText } = render(
      <AgentSessions
        agentName="Pipeline Agent"
        agentId="app_x"
        requestedSessionId="s1"
      />,
    );
    // Wait for the HYDRATED pane (the seeded pane has no mirroring hook).
    await findByText("Weekly recap run");
    await waitFor(() =>
      expect(getByTestId("transcript").textContent).toContain(
        "Recap saved to Artifacts.",
      ),
    );
    fireEvent.click(getByText("emit turn"));
    await waitFor(() => {
      const mirrored = fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.endsWith("/message"),
      );
      expect(mirrored).toHaveLength(2);
    });
    const bodies = fetchMock.mock.calls
      .filter(([url]) => typeof url === "string" && url.endsWith("/message"))
      .map(([url, init]) => ({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      }));
    expect(bodies[0].url).toBe("/agent/sessions/s1/message");
    expect(bodies[0].body).toEqual({
      schema_version: 1,
      agent: "app_x",
      from: "you",
      body: "hi agent",
    });
    expect(bodies[1].body).toMatchObject({
      from: "nex",
      body: "hello operator",
    });
  });

  it("New chat POSTs a session and opens the created one", async () => {
    const fetchMock = serviceFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByLabelText } = render(
      <AgentSessions agentName="Pipeline Agent" agentId="app_x" />,
    );
    await findByText("Weekly recap run"); // hydrated
    fireEvent.click(getByLabelText("New chat"));
    expect(await findByText("Chat 3")).toBeTruthy();
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/agent/sessions" && init?.method === "POST",
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      schema_version: 1,
      agent: "app_x",
      title: "Chat 3",
    });
  });

  it("keeps a requested session active when hydration resolves later (regression)", async () => {
    // "Open its chat" fires open(requestedSessionId) at mount, BEFORE the
    // session-list fetch resolves; hydration used to clobber the active pane
    // back to the FIRST session, dropping the operator into the wrong chat.
    vi.stubGlobal("fetch", serviceFetch());
    const { findByText } = render(
      <AgentSessions
        agentName="Pipeline Agent"
        agentId="app_x"
        requestedSessionId="s2"
      />,
    );
    const requested = (await findByText("Chat")).closest("button");
    await waitFor(() => expect(requested?.className).toContain("is-active"));
    const first = (await findByText("Weekly recap run")).closest("button");
    expect(first?.className).not.toContain("is-active");
  });

  it("defaults to a fresh manual chat when the service has only routine sessions (regression)", async () => {
    // A real agent whose sessions are all ROUTINE runs used to open the routine
    // session by default, so manual chatting polluted its run transcript. The
    // default must be a MANUAL chat instead.
    const routineOnly = [
      {
        id: "s1",
        agent: "app_x",
        title: "Weekly recap run",
        kind: "routine",
        at: "Monday 9:02",
        routine: "routine-recap",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/agent/sessions?agent=app_x") {
          return ok({ sessions: routineOnly });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { findByText, getByText } = render(
      <AgentSessions agentName="Pipeline Agent" agentId="app_x" />,
    );
    // The routine session still shows in the strip…
    expect(await findByText("Weekly recap run")).toBeTruthy();
    // …but the ACTIVE default is a fresh manual chat, not the routine's run.
    const manual = getByText("Chat with your agent").closest("button");
    await waitFor(() => expect(manual?.className).toContain("is-active"));
    const routine = getByText("Weekly recap run").closest("button");
    expect(routine?.className).not.toContain("is-active");
  });

  it("creates the draft manual session on the first sent turn (not before)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/agent/sessions?agent=app_x") {
        return ok({
          sessions: [
            {
              id: "s1",
              agent: "app_x",
              title: "Weekly recap run",
              kind: "routine",
              at: "Monday 9:02",
            },
          ],
        });
      }
      if (url === "/agent/sessions" && init?.method === "POST") {
        return ok({
          session: {
            id: "s9",
            agent: "app_x",
            title: "Chat with your agent",
            kind: "manual",
            at: "just now",
          },
        });
      }
      if (url.endsWith("/message") && init?.method === "POST") {
        return ok({ ok: true });
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByText } = render(
      <AgentSessions agentName="Pipeline Agent" agentId="app_x" />,
    );
    await findByText("Chat with your agent");
    // No session was created just to have a default (no POST /sessions yet).
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === "/agent/sessions" && init?.method === "POST",
      ),
    ).toBe(false);
    // The first turn persists the session, then mirrors both messages to it.
    fireEvent.click(getByText("emit turn"));
    await waitFor(() => {
      const mirrored = fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.endsWith("/message"),
      );
      expect(mirrored).toHaveLength(2);
    });
    const created = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/agent/sessions" && init?.method === "POST",
    );
    expect(created).toHaveLength(1);
    const mirroredUrls = fetchMock.mock.calls
      .filter(([url]) => typeof url === "string" && url.endsWith("/message"))
      .map(([url]) => url);
    // Both turns mirror to the SAME newly-created session id.
    expect(mirroredUrls).toEqual([
      "/agent/sessions/s9/message",
      "/agent/sessions/s9/message",
    ]);
  });
});
