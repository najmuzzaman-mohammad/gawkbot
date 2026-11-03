import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataRecord } from "../../../api/dataspaces";
import { RECRUITING_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { dataKeys } from "../../../hooks/useDataSpaces";
import { ToastContainer } from "../../ui/Toast";
import { mockClient, resetMockClient, typeBySlug } from "./testClient";
import { isPendingValue, useValueCommit } from "./useValueCommit";

vi.mock("../../../api/dataspacesClient", async () =>
  (await import("./testClient")).mockClientModule(),
);

beforeEach(() => {
  resetMockClient();
});

async function ratedInterview(): Promise<DataRecord> {
  const type = await typeBySlug(RECRUITING_SPACE_ID, "interview");
  const page = await mockClient().queryRecords(RECRUITING_SPACE_ID, {
    typeId: type.id,
    filters: [{ attribute: "rating", operator: "is_not_empty" }],
    limit: 1,
    offset: 0,
  });
  return page.records[0];
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
      <ToastContainer />
    </QueryClientProvider>
  );
  const hook = renderHook(() => useValueCommit(RECRUITING_SPACE_ID), {
    wrapper,
  });
  return { queryClient, hook };
}

describe("useValueCommit", () => {
  it("a rating of 7 is rejected: the old value comes back and the message is shown", async () => {
    const interview = await ratedInterview();
    const original = interview.values.rating;
    const { queryClient, hook } = setup();
    const key = dataKeys.record(RECRUITING_SPACE_ID, interview.id);
    queryClient.setQueryData(key, interview);

    act(() => hook.result.current.commit(interview, "rating", 7));
    expect(
      isPendingValue(hook.result.current.pending, interview.id, "rating"),
    ).toBe(true);

    expect(
      await screen.findByText(
        /Rating must be a whole number from 1 to 5; got 7/,
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(hook.result.current.pending).toBeNull());
    expect(queryClient.getQueryData<DataRecord>(key)?.values.rating).toBe(
      original,
    );
    const stored = await mockClient().getRecord(
      RECRUITING_SPACE_ID,
      interview.id,
    );
    expect(stored.values.rating).toBe(original);
  });

  it("a valid rating is written and the pending target clears", async () => {
    const interview = await ratedInterview();
    const next = interview.values.rating === 5 ? 4 : 5;
    const { hook } = setup();
    act(() => hook.result.current.commit(interview, "rating", next));
    await waitFor(() => expect(hook.result.current.pending).toBeNull());
    const stored = await mockClient().getRecord(
      RECRUITING_SPACE_ID,
      interview.id,
    );
    expect(stored.values.rating).toBe(next);
  });
});
