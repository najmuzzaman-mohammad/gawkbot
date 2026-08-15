// Shell-level regression guard: the sidebar rail is the REAL inventory only.
// Mock drafts (mock/data TOOLS) must never appear in the rail or inflate the
// Agents badge — the operator sees exactly the agents they built.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CustomApp } from "../api/apps";
import { TOOLS } from "./mock/data";
import { OperatorApp } from "./OperatorApp";

// Drive the apps hook directly (no network) — the same seam
// InternalToolsSurface.test.tsx uses. The shell itself still needs a React
// Query provider for its office-identity config query; give it an inert one.
const useOperatorAppsMock = vi.fn();
vi.mock("./apps/useOperatorApps", () => ({
  useOperatorApps: () => useOperatorAppsMock(),
  useDeleteApp: () => ({ mutate: vi.fn(), isPending: false }),
  appBuildState: () => "ready",
  isRealAppId: (id: unknown): boolean =>
    typeof id === "string" && id.startsWith("app_"),
}));
vi.mock("./apps/useRealtimeConfig", () => ({
  useRealtimeConfig: () => ({ available: false, model: "gpt-realtime-2" }),
}));
// ApprovalPrompt polls the broker through React Query; not under test here.
vi.mock("./components/ApprovalPrompt", () => ({
  ApprovalPrompt: () => null,
}));

function app(id: string, name: string): CustomApp {
  return {
    id,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    icon: "📋",
    entry: "index.html",
    version: 1,
    createdBy: "app-builder",
    createdAt: "2026-06-30T10:00:00Z",
    updatedAt: "2026-06-30T10:00:00Z",
    contentHash: "h",
  };
}

describe("OperatorApp sidebar composition", () => {
  it("rails and badges ONLY the real agents; mock drafts never render", () => {
    useOperatorAppsMock.mockReturnValue({
      data: [
        app("app_1111111111111111", "Renewal radar"),
        app("app_2222222222222222", "Digest bot"),
      ],
      isLoading: false,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    const { container, queryByText } = render(
      <QueryClientProvider client={client}>
        <OperatorApp />
      </QueryClientProvider>,
    );

    const badge = container.querySelector(".opr-nav-count");
    expect(badge?.textContent).toBe("2");

    // Exactly the two real agents in the rail, in inventory order.
    const railNames = [
      ...container.querySelectorAll(
        ".opr-agent-rail-item .opr-agent-rail-name",
      ),
    ].map((el) => el.textContent);
    expect(railNames).toEqual(["Renewal radar", "Digest bot"]);

    // No Suggested section, and no mock draft anywhere in the shell.
    expect(queryByText("Suggested")).toBeNull();
    for (const t of TOOLS) {
      expect(queryByText(t.name)).toBeNull();
    }
  });
});
