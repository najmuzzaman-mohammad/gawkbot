import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import type {
  DataRecord,
  ObjectType,
  SpaceSchema,
} from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { useRecordPage, useSpaceSchema } from "../../../hooks/useDataSpaces";
import { routeTree } from "../../../lib/router";
import { ToastContainer } from "../../ui/Toast";
import { createDataHarnessQueryClient } from "./DataRouteHarness";

import "../../../styles/data.css";

/**
 * Stories only. Component stories need what the pages get for free: a router
 * (they render <Link> and some read URL search state), a query client, and
 * the `data-section` container their container queries key off. The story's
 * own JSX is rendered at the router root through a context slot.
 */
const SlotContext = createContext<ReactNode>(null);

function Slot() {
  return useContext(SlotContext);
}

export const SEED_INVESTORS_PATH = `/data/${SEED_RAISE_SPACE_ID}/t/investor`;

export interface DataStoryShellProps {
  /** Must match the records table route for stories that read its search. */
  path?: string;
  /** Any CSS width, to exercise the container queries. */
  width?: string;
  children: ReactNode;
}

export function DataStoryShell({
  path = SEED_INVESTORS_PATH,
  width = "100%",
  children,
}: DataStoryShellProps) {
  const [router] = useState(() =>
    createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
      defaultComponent: Slot,
    }),
  );
  const [queryClient] = useState(createDataHarnessQueryClient);
  const style: CSSProperties = {
    width,
    maxWidth: "100%",
    display: "flex",
    flexDirection: "column",
    padding: "var(--space-4)",
    background: "var(--bg)",
  };
  return (
    <QueryClientProvider client={queryClient}>
      <SlotContext.Provider
        value={
          <div className="data-section" style={style}>
            {children}
          </div>
        }
      >
        <RouterProvider router={router} />
      </SlotContext.Provider>
      <ToastContainer />
    </QueryClientProvider>
  );
}

export interface SeedContext {
  schema: SpaceSchema;
  type: ObjectType;
  records: readonly DataRecord[];
}

export interface SeedDataProps {
  spaceId?: string;
  typeSlug?: string;
  children: (seed: SeedContext) => ReactNode;
}

/** Loads fixture data through the real hooks (the client is the mock). */
export function SeedData({
  spaceId = SEED_RAISE_SPACE_ID,
  typeSlug = "investor",
  children,
}: SeedDataProps) {
  const schema = useSpaceSchema(spaceId);
  const type = schema.data?.objectTypes.find((item) => item.slug === typeSlug);
  const page = useRecordPage(spaceId, {
    typeId: type?.id ?? "",
    limit: 30,
    offset: 0,
  });
  if (!(schema.data && type && page.data)) {
    return <p style={{ color: "var(--text-secondary)" }}>Loading fixtures</p>;
  }
  return children({ schema: schema.data, type, records: page.data.records });
}
