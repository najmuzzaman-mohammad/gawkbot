import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as rtlRender } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomAppDetail } from "../../api/apps";
import { AppDetail } from "./AppDetail";

// Control the data hook so we can render the building vs ready states without a
// network or React Query provider.
// The detail component now uses React Query directly (deterministic build
// refresh), so every render needs a provider. Inert client: queries that the
// mocks don't intercept stay idle instead of hitting the network.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  const wrap = (el: ReactElement) => (
    <QueryClientProvider client={client}>{el}</QueryClientProvider>
  );
  const result = rtlRender(wrap(ui));
  return {
    ...result,
    rerender: (el: ReactElement) => result.rerender(wrap(el)),
  };
}

const useOperatorAppMock = vi.fn();
vi.mock("../apps/useOperatorApps", () => ({
  useOperatorApp: (id: string) => useOperatorAppMock(id),
  // Drive build state from status in tests (ignore the createdAt age heuristic).
  appBuildState: (app: { status?: string }) =>
    app.status === "building" ? "building" : "ready",
  useDeleteApp: () => ({ mutate: vi.fn(), isPending: false }),
  // Real-id check used by the bot-service wiring.
  isRealAppId: (id: string | null | undefined) =>
    typeof id === "string" && id.startsWith("app_"),
}));

// Stub the sandbox frame (real iframe) and the integrations tab (fetches the
// catalog) so the test stays unit-scoped.
vi.mock("../../components/apps/CustomAppFrame", () => ({
  CustomAppFrame: ({ appId, html }: { appId: string; html: string }) => (
    <div data-testid="app-frame" data-app-id={appId}>
      {html}
    </div>
  ),
}));
// AppLivePreview runs a dev-server query; stub it so a building app's UI tab is
// unit-testable without a QueryClient or a real dev server.
vi.mock("../../components/apps/AppLivePreview", () => ({
  AppLivePreview: ({ appId }: { appId: string }) => (
    <div data-testid="live-preview" data-app-id={appId} />
  ),
}));
vi.mock("./ToolIntegrations", () => ({
  ToolIntegrations: () => <div data-testid="tool-integrations" />,
}));

function detail(
  over: Partial<CustomAppDetail["app"]>,
  html: string,
): CustomAppDetail {
  return {
    app: {
      id: "app_abc",
      slug: "x",
      name: "Open Tasks",
      icon: "📋",
      entry: "index.html",
      version: 1,
      createdBy: "app-builder",
      createdAt: "2026-06-29T10:00:00Z",
      updatedAt: "2026-06-29T10:00:00Z",
      contentHash: "h",
      ...over,
    },
    html,
  };
}

function ready() {
  useOperatorAppMock.mockReturnValue({
    data: detail({ status: "ready" }, "<html>hi</html>"),
    isError: false,
  });
}

describe("AppDetail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the live preview (UI builds in front of you) while building", () => {
    useOperatorAppMock.mockReturnValue({
      data: detail({ status: "building" }, ""),
      isError: false,
    });
    const { getByTestId, queryByTestId } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    // The building app's UI tab shows the live dev-server preview, not the
    // sealed published frame.
    expect(getByTestId("live-preview").getAttribute("data-app-id")).toBe(
      "app_abc",
    );
    expect(queryByTestId("app-frame")).toBeNull();
  });

  it("renders the live app in the UI tab once ready", () => {
    ready();
    const { getByTestId } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    const frame = getByTestId("app-frame");
    expect(frame.getAttribute("data-app-id")).toBe("app_abc");
    expect(frame.textContent).toContain("<html>hi</html>");
  });

  it("collects the bot service's artifacts under the live app on the UI tab", async () => {
    ready();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/agent/artifacts?agent=app_abc") {
        return {
          ok: true,
          json: async () => ({
            artifacts: [
              {
                id: "art_1",
                type: "md",
                title: "weekly-recap.md",
                producedBy: "Monday pipeline recap",
                at: "Monday 9:02",
                content: "# Recap",
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container, findByText, getByTestId, getByText } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    // The persisted artifact renders in the strip under the app…
    expect(await findByText("weekly-recap.md")).toBeTruthy();
    expect(getByText("Artifacts")).toBeTruthy();
    // …while the app itself stays THE UI (rendered once, not an artifact chip).
    expect(getByTestId("app-frame")).toBeTruthy();
    const chips = container.querySelectorAll(".opr-artifact-chip");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain("weekly-recap.md");
  });

  it("shows no artifacts section when the bot has produced nothing", () => {
    ready();
    // The bot service is unreachable: the UI tab is just the app.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    const { getByTestId, queryByText } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    expect(getByTestId("app-frame")).toBeTruthy();
    expect(queryByText("Artifacts")).toBeNull();
  });
});

// An app is a surface, not a place you talk to a bot. The tab set is
// deliberately three: what it looks like, what it stores, what it is plugged
// into. Routines moved to the global Scheduled Tasks nav, Knowledge moved to
// the bot scope, and tool authoring + the Demo capture are gone from apps
// entirely — so a regression that quietly re-adds one of them fails here.
describe("AppDetail tab set", () => {
  it("offers exactly UI, Data and Integrations", () => {
    ready();
    const { getAllByRole } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    expect(getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "UI",
      "Data",
      "Integrations",
    ]);
  });

  it("has no Routines, Tools, Demo or Knowledge tab", () => {
    ready();
    const { queryByRole } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    for (const name of [/^routines$/i, /^tools$/i, /^demo$/i, /^knowledge$/i]) {
      expect(queryByRole("tab", { name })).toBeNull();
    }
  });

  it("routes the Integrations tab to the workspace catalog", () => {
    ready();
    const { getByRole, getByTestId } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    fireEvent.click(getByRole("tab", { name: "Integrations" }));
    expect(getByTestId("tool-integrations")).toBeTruthy();
  });
});

// The founder's rule: you chat with a bot in its DM, nowhere else. An app
// carries no chat pane, no floating "Ask Bot" bubble, and no docked drawer.
const ASK_AGENT = /ask (agent|ai|gawkbot)/i;

describe("AppDetail has no bot chat", () => {
  it("offers no Ask Bot affordance on a ready app", () => {
    ready();
    const { container, queryByRole } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    // Not a bare /ask/ — the app is named "Open Tasks", which contains it.
    expect(queryByRole("button", { name: ASK_AGENT })).toBeNull();
    expect(container.querySelector(".opr-ask-panel")).toBeNull();
    expect(container.querySelector(".opr-ask-fab")).toBeNull();
  });

  it("offers no Ask Bot affordance while the app is building", () => {
    useOperatorAppMock.mockReturnValue({
      data: detail({ status: "building" }, ""),
      isError: false,
    });
    const { container, queryByRole } = render(
      <AppDetail appId="app_abc" onBack={() => {}} />,
    );
    expect(queryByRole("button", { name: ASK_AGENT })).toBeNull();
    expect(container.querySelector(".opr-ask-fab")).toBeNull();
  });
});

describe("AppDetail build walk narration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderWalk() {
    ready();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    return render(
      <AppDetail appId="app_abc" onBack={() => {}} buildWalk={true} />,
    );
  }

  it("captions the Data step, then falls silent when the walk settles", () => {
    vi.useFakeTimers();
    const { getByText, queryByText } = renderWalk();
    // Before the walk starts: no caption.
    expect(queryByText(/Its own database/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(
      getByText("Its own database. It fills up as it works."),
    ).toBeTruthy();
    // The walk settles back on the UI tab and the narration goes away.
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(queryByText(/Its own database/)).toBeNull();
  });

  it("only ever selects tabs that still exist", () => {
    vi.useFakeTimers();
    const { container } = renderWalk();
    // Run the whole walk and assert the panel never lands on a removed tab id
    // — a setTab pointing at a deleted tab renders a blank pane, not an error.
    for (const _ of [0, 1, 2, 3]) {
      act(() => {
        vi.advanceTimersByTime(900);
      });
      const panel = container.querySelector("[role='tabpanel']");
      expect(panel?.id).toMatch(/^opr-panel-(ui|data|integrations)$/);
    }
  });

  it("clears the caption the moment the operator clicks a tab themselves", () => {
    vi.useFakeTimers();
    const { getByRole, getByText, queryByText } = renderWalk();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(
      getByText("Its own database. It fills up as it works."),
    ).toBeTruthy();
    // A manual click cancels the walk AND its narration.
    fireEvent.click(getByRole("tab", { name: "Integrations" }));
    expect(queryByText(/Its own database/)).toBeNull();
    // The cancelled timers never resurrect a caption.
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(queryByText(/Its own database/)).toBeNull();
  });
});

// The app's ONE conversational affordance, and the founder's stated replacement
// for the removed chat: an edit request that goes to the bot building the app.
describe("AppDetail edit affordance", () => {
  it("offers Edit app on a ready bot and hands back the app identity", () => {
    ready();
    const onEditApp = vi.fn();
    const { getByRole } = render(
      <AppDetail appId="app_abc" onBack={() => {}} onEditApp={onEditApp} />,
    );
    fireEvent.click(getByRole("button", { name: /edit app/i }));
    expect(onEditApp).toHaveBeenCalledWith({
      id: "app_abc",
      name: "Open Tasks",
    });
  });

  it("hides Edit app while building and when no handler is wired", () => {
    useOperatorAppMock.mockReturnValue({
      data: detail({ status: "building" }, ""),
      isError: false,
    });
    const { queryByRole, rerender } = render(
      <AppDetail appId="app_abc" onBack={() => {}} onEditApp={vi.fn()} />,
    );
    expect(queryByRole("button", { name: /edit app/i })).toBeNull();

    // Ready but no handler (e.g. inside the build experience): no dead button.
    ready();
    rerender(<AppDetail appId="app_abc" onBack={() => {}} />);
    expect(queryByRole("button", { name: /edit app/i })).toBeNull();
  });
});
