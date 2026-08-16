import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppKnowledgeTab } from "./AppKnowledgeTab";

// vi.mock is hoisted above this file's const declarations, so the mock handle
// must be hoisted too or the factory hits the TDZ.
const { fetchCatalog, fetchArticle } = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
  fetchArticle: vi.fn(),
}));
vi.mock("../../api/wiki", () => ({ fetchCatalog, fetchArticle }));

function wrap(node: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("AppKnowledgeTab", () => {
  beforeEach(() => {
    fetchCatalog.mockReset();
    fetchArticle.mockReset();
  });

  it("names concrete pages in the empty state, not just the mechanism", async () => {
    fetchCatalog.mockResolvedValue([]);
    const { getByText } = wrap(<AppKnowledgeTab />);
    await waitFor(() => expect(getByText(/No knowledge yet/)).toBeTruthy());
    // The promise stays concrete: pages a revenue leader would recognize,
    // mirroring the onboarding wizard's own examples.
    expect(getByText(/how you route a lead/)).toBeTruthy();
    expect(getByText(/stale deal/)).toBeTruthy();
  });

  it("keeps the offline state straight, with no example copy", async () => {
    fetchCatalog.mockRejectedValue(new Error("down"));
    const { getByText, queryByText } = wrap(<AppKnowledgeTab />);
    await waitFor(() => expect(getByText(/Knowledge is offline/)).toBeTruthy());
    expect(queryByText(/stale deal/)).toBeNull();
  });
});
