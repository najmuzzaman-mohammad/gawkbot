/**
 * Shared setup for the mock data client tests: a zero-latency client on an
 * empty space, sequential ids, and a clock the test can move.
 */

import {
  type AttributeDefinition,
  type AttributeInput,
  type DataClient,
  DataValidationError,
  type ObjectType,
} from "./dataspaces";
import { EMPTY_SPACE_ID, type FixtureSeed } from "./dataspaces.fixtures";
import { createMockDataClient } from "./dataspaces.mock";

export interface TestKit {
  client: DataClient;
  spaceId: string;
  /** Moves the client's clock forward. */
  advance(ms: number): void;
  type(name: string): Promise<ObjectType>;
  attr(typeId: string, input: AttributeInput): Promise<AttributeDefinition>;
  /** Adds a relationship attribute with an inverse on the target. */
  relate(
    typeId: string,
    name: string,
    targetTypeId: string,
    cardinality: "one_to_one" | "many_to_one" | "one_to_many" | "many_to_many",
    inverseName: string,
  ): Promise<AttributeDefinition>;
  /** Reads an object type back from the schema. */
  readType(typeId: string): Promise<ObjectType>;
}

export function createTestKit(
  seed: FixtureSeed = { emptySpace: true },
): TestKit {
  let clock = Date.parse("2026-09-17T12:00:00.000Z");
  let counter = 0;
  const client = createMockDataClient(seed, {
    delayMs: 0,
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    mintToken: () => {
      counter += 1;
      return `t${counter}`;
    },
  });
  const spaceId = EMPTY_SPACE_ID;
  return {
    client,
    spaceId,
    advance(ms) {
      clock += ms;
    },
    type: (name) => client.createObjectType(spaceId, { name }),
    attr: (typeId, input) => client.addAttribute(spaceId, typeId, input),
    relate: (typeId, name, targetTypeId, cardinality, inverseName) =>
      client.addAttribute(spaceId, typeId, {
        name,
        type: "relationship",
        relationship: { targetTypeId, cardinality, inverseName },
      }),
    async readType(typeId) {
      const schema = await client.getSchema(spaceId);
      const found = schema.objectTypes.find((type) => type.id === typeId);
      if (!found) throw new Error(`type ${typeId} not in schema`);
      return found;
    },
  };
}

/** Awaits a rejection and returns it, failing if the promise resolved. */
export async function validationError(
  promise: Promise<unknown>,
): Promise<DataValidationError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DataValidationError) return error;
    throw error;
  }
  throw new Error("expected a DataValidationError, but the call succeeded");
}
