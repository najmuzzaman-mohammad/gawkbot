/**
 * Deterministic builder for fixture spaces. Fixtures are produced by running
 * the same engine the mock client uses, so inverse attributes, option ids,
 * and link symmetry are correct by construction, and every value has passed
 * the real validation. Ids are sequential and the clock is synthetic, so the
 * output is identical on every run.
 */

import type {
  AttributeDefinition,
  AttributeInput,
  AttributePatch,
  ObjectTypeInput,
  RecordValuesPatch,
  SpaceAccess,
} from "./dataspaces";
import { createRecord, linkRecords } from "./dataspaces.mock.records";
import {
  addAttribute,
  createObjectType,
  updateAttribute,
} from "./dataspaces.mock.schema";
import {
  ACTOR_HUMAN,
  type MockContext,
  primaryAttribute,
  requireType,
  type SpaceState,
} from "./dataspaces.mock.store";
import { normalizeAccess, PRIVATE_ACCESS } from "./dataspacesAccess";

const CLOCK_STEP_MS = 37 * 60 * 1000;

export interface SpaceBuilderInit {
  id: string;
  /** Short key baked into every minted id, e.g. `rec_seed_12`. */
  key: string;
  name: string;
  description: string;
  owner: string;
  attachedAppIds?: readonly string[];
  /** Defaults to private. Normalized, so an invalid value throws. */
  access?: SpaceAccess;
  /** ISO timestamp the synthetic clock starts from. */
  startAt: string;
}

export interface SpaceBuilder {
  /** Returns the new object type id. `by` defaults to the owner bot. */
  type(input: ObjectTypeInput, by?: string): string;
  attribute(
    typeId: string,
    input: AttributeInput,
    by?: string,
  ): AttributeDefinition;
  renamePrimary(typeId: string, name: string): void;
  /** Returns the new record id. */
  record(typeId: string, values: RecordValuesPatch, by?: string): string;
  link(recordId: string, attributeSlug: string, targetId: string): void;
  done(): SpaceState;
}

/** Small seeded PRNG (mulberry32) so bulk fixture data is stable. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

export function emptySpaceState(init: SpaceBuilderInit): SpaceState {
  return {
    space: {
      id: init.id,
      name: init.name,
      description: init.description,
      owner: init.owner,
      objectTypeCount: 0,
      recordCount: 0,
      attachedAppIds: [...(init.attachedAppIds ?? [])],
      access: normalizeAccess(init.owner, init.access ?? PRIVATE_ACCESS),
      createdAt: init.startAt,
      updatedAt: init.startAt,
    },
    objectTypes: [],
    relationships: [],
    records: [],
    links: [],
  };
}

export function createSpaceBuilder(init: SpaceBuilderInit): SpaceBuilder {
  let state = emptySpaceState(init);
  let clock = Date.parse(init.startAt);
  const counters = new Map<string, number>();

  const contextFor = (actor: string): MockContext => ({
    actor,
    now: () => {
      clock += CLOCK_STEP_MS;
      return new Date(clock);
    },
    mintId: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${init.key}_${next}`;
    },
  });

  return {
    type(input, by = init.owner) {
      const out = createObjectType(state, contextFor(by), input);
      state = out.state;
      return out.result.id;
    },
    attribute(typeId, input, by = init.owner) {
      const out = addAttribute(state, contextFor(by), typeId, input);
      state = out.state;
      return out.result;
    },
    renamePrimary(typeId, name) {
      const primary = primaryAttribute(requireType(state, typeId));
      const patch: AttributePatch = { name };
      const ctx = contextFor(init.owner);
      state = updateAttribute(state, ctx, typeId, primary.id, patch).state;
    },
    record(typeId, values, by = init.owner) {
      const out = createRecord(state, contextFor(by), typeId, values);
      state = out.state;
      return out.record.id;
    },
    link(recordId, attributeSlug, targetId) {
      const ctx = contextFor(ACTOR_HUMAN);
      state = linkRecords(
        state,
        ctx,
        recordId,
        attributeSlug,
        targetId,
        false,
      ).state;
    },
    done() {
      const updatedAt = new Date(clock).toISOString();
      return { ...state, space: { ...state.space, updatedAt } };
    },
  };
}
