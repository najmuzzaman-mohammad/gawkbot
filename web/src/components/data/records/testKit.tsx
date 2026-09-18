import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  createDataHarnessQueryClient,
  createDataHarnessRouter,
  DataRouteHarness,
} from "./DataRouteHarness";

/** Test-only render helpers. The swappable client lives in testClient.ts. */
export function renderDataRoute(initialPath: string) {
  const router = createDataHarnessRouter(initialPath);
  const queryClient = createDataHarnessQueryClient();
  const user = userEvent.setup();
  const view = render(
    <DataRouteHarness
      initialPath={initialPath}
      router={router}
      queryClient={queryClient}
    />,
  );
  return { router, queryClient, user, ...view };
}

/** Names in the primary column, top to bottom. */
export function rowNames(): string[] {
  return screen
    .getAllByTestId("data-record-row")
    .map((row) => row.querySelector(".dr-name-link")?.textContent ?? "");
}
