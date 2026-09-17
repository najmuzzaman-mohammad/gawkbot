import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

/**
 * Test and Storybook harness for the Data screens. They render `<Link>` and
 * call `useNavigate`, so they need a router; they read through React Query,
 * so they need a client. The router here knows the `/data/**` paths but
 * always renders the node it was given, which keeps one screen on stage
 * while `router.state.location` still records where a navigation went.
 */

const DATA_PATHS = [
  "/data",
  "/data/$spaceId",
  "/data/$spaceId/t/$typeSlug",
  "/data/$spaceId/t/$typeSlug/settings",
  "/data/$spaceId/r/$recordId",
] as const;

export function createHarnessQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function createHarnessRouter(node: ReactNode, initialPath = "/data") {
  const rootRoute = createRootRoute({ component: () => <>{node}</> });
  const routes = DATA_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  );
  return createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

export type HarnessRouter = ReturnType<typeof createHarnessRouter>;

interface DataHarnessProps {
  router: HarnessRouter;
  queryClient: QueryClient;
}

export function DataHarness({ router, queryClient }: DataHarnessProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
