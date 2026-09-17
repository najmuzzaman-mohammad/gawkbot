import type { DataClient, ObjectType } from "../../../api/dataspaces";
import { createMockDataClient } from "../../../api/dataspaces.mock";

/**
 * Test-only. The hooks import the `dataClient` singleton, so each test file
 * mocks that module with `mockClientModule()`: a proxy over a client that
 * `resetMockClient()` swaps for a fresh one before every test.
 *
 *   vi.mock("../../../api/dataspacesClient", async () =>
 *     (await import("./testClient")).mockClientModule(),
 *   );
 *
 * This file must not import any component. The mock factory awaits it while
 * the component graph is itself waiting on the mocked module; a component
 * import here closes that circle and the test run hangs at collection.
 */
let current: DataClient = createMockDataClient(undefined, { delayMs: 0 });

export function resetMockClient(): DataClient {
  current = createMockDataClient(undefined, { delayMs: 0 });
  return current;
}

export function mockClient(): DataClient {
  return current;
}

export function mockClientModule(): { dataClient: DataClient } {
  const dataClient = new Proxy({} as DataClient, {
    get: (_target, key) => Reflect.get(current, key),
  });
  return { dataClient };
}

export async function typeBySlug(
  spaceId: string,
  slug: string,
): Promise<ObjectType> {
  const schema = await current.getSchema(spaceId);
  const type = schema.objectTypes.find((item) => item.slug === slug);
  if (!type) throw new Error(`No object type "${slug}" in ${spaceId}`);
  return type;
}
