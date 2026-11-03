import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DataClient, ObjectType } from "../../../api/dataspaces";
import type { FixtureSeed } from "../../../api/dataspaces.fixtures";
import { createMockDataClient } from "../../../api/dataspaces.mock";
import {
  createHarnessQueryClient,
  createHarnessRouter,
  DataHarness,
} from "./dataHarness";

/** A zero-latency client with its own copy of the fixtures. */
export function createTestClient(seed?: FixtureSeed): DataClient {
  return createMockDataClient(seed, { delayMs: 0 });
}

/** Renders a Data screen inside the router and query harness. */
export function renderData(node: ReactNode, initialPath = "/data") {
  const router = createHarnessRouter(node, initialPath);
  const queryClient = createHarnessQueryClient();
  const user = userEvent.setup();
  const view = render(
    <DataHarness router={router} queryClient={queryClient} />,
  );
  return { ...view, router, queryClient, user };
}

export async function typeByName(
  client: DataClient,
  spaceId: string,
  name: string,
): Promise<ObjectType> {
  const schema = await client.getSchema(spaceId);
  const found = schema.objectTypes.find((type) => type.name === name);
  if (!found) throw new Error(`fixture type ${name} missing`);
  return found;
}
