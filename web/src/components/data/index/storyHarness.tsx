import { type CSSProperties, type ReactNode, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";

import type { DataSpace, SpaceSchema } from "../../../api/dataspaces";
import { dataKeys, useSpaceSchema } from "../../../hooks/useDataSpaces";
import {
  createHarnessQueryClient,
  createHarnessRouter,
  DataHarness,
} from "./dataHarness";

import "../../../styles/data.css";
import "../../../styles/data-schema.css";

const frameStyle: CSSProperties = {
  minHeight: "100vh",
  background: "var(--bg)",
  fontFamily: "var(--font-sans)",
};

interface DataStoryProps {
  children: ReactNode;
  initialPath?: string;
  /**
   * Pins the spaces list for the story, e.g. `[]` for the empty state. Left
   * out, the screen reads the in-memory mock client and its three fixtures.
   */
  spaces?: readonly DataSpace[];
}

function seededQueryClient(spaces: readonly DataSpace[] | undefined) {
  const queryClient: QueryClient = createHarnessQueryClient();
  if (spaces !== undefined) {
    queryClient.setQueryDefaults(dataKeys.spaces(), { staleTime: Infinity });
    queryClient.setQueryData(dataKeys.spaces(), spaces);
  }
  return queryClient;
}

/**
 * Stories only. Mounts a Data screen the way `DataSection` does (same root
 * classes, so the `data-section` container queries apply) inside a memory
 * router and a query client.
 */
export function DataStory({ children, initialPath, spaces }: DataStoryProps) {
  const [queryClient] = useState(() => seededQueryClient(spaces));
  const [router] = useState(() =>
    createHarnessRouter(
      <div className="app-panel active data-section" style={frameStyle}>
        {children}
      </div>,
      initialPath,
    ),
  );
  return <DataHarness router={router} queryClient={queryClient} />;
}

interface WithSchemaProps {
  spaceId: string;
  children: (schema: SpaceSchema) => ReactNode;
}

/** Loads a fixture schema for stories of components that take it as props. */
export function WithSchema({ spaceId, children }: WithSchemaProps) {
  const schemaQuery = useSpaceSchema(spaceId);
  if (!schemaQuery.data) return null;
  return <>{children(schemaQuery.data)}</>;
}

/** The named object type, or the first one, from a fixture schema. */
export function pickType(schema: SpaceSchema, name: string) {
  return (
    schema.objectTypes.find((type) => type.name === name) ??
    schema.objectTypes[0]
  );
}
