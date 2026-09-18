import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { routeTree } from "../../../lib/router";
import { useCurrentRoute } from "../../../routes/useCurrentRoute";
import { ToastContainer } from "../../ui/Toast";
import { RecordPage } from "../record/RecordPage";
import { RecordsPage } from "./RecordsPage";

import "../../../styles/data.css";

/**
 * Mounts the records and record screens on the REAL route tree with an
 * in-memory history, for stories and tests. The pages read and write URL
 * search state and render <Link>s, so they need a router around them; this
 * is the smallest one that is still the production route table.
 *
 * The app sets its shell on the root route in main.tsx. Nothing does that
 * here, so `defaultComponent` stands in at the root and renders the matched
 * Data screen itself, the same way `DataSection` does.
 */
function HarnessScreen() {
  const route = useCurrentRoute();
  return (
    <div
      className="app-panel active data-section"
      data-testid="data-harness"
      data-route={route.kind}
    >
      {route.kind === "data-type" ? (
        <RecordsPage spaceId={route.spaceId} typeSlug={route.typeSlug} />
      ) : route.kind === "data-record" ? (
        <RecordPage spaceId={route.spaceId} recordId={route.recordId} />
      ) : (
        <p data-testid="data-harness-elsewhere">Navigated to {route.kind}</p>
      )}
    </div>
  );
}

export function createDataHarnessRouter(initialPath: string) {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    defaultComponent: HarnessScreen,
  });
}

export type DataHarnessRouter = ReturnType<typeof createDataHarnessRouter>;

export function createDataHarnessQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export interface DataRouteHarnessProps {
  /** e.g. `/data/space_seed_raise/t/investor?sort=stage`. */
  initialPath: string;
  /** Tests pass their own to read the location afterwards. */
  router?: DataHarnessRouter;
  queryClient?: QueryClient;
}

export function DataRouteHarness({
  initialPath,
  router,
  queryClient,
}: DataRouteHarnessProps) {
  const [ownRouter] = useState(
    () => router ?? createDataHarnessRouter(initialPath),
  );
  const [ownClient] = useState(
    () => queryClient ?? createDataHarnessQueryClient(),
  );
  return (
    <QueryClientProvider client={ownClient}>
      <RouterProvider router={ownRouter} />
      <ToastContainer />
    </QueryClientProvider>
  );
}
