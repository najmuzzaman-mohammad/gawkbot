import type { DataClient } from "./dataspaces";
import { createMockDataClient } from "./dataspaces.mock";

// Until the broker `/data/spaces/**` routes land (slice S3 of
// docs/specs/agent-data-model.md) the client is the in-memory mock. S3 swaps
// this one line for the broker-backed client; the interface does not change.
export const dataClient: DataClient = createMockDataClient();
