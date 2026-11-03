/**
 * In-memory `DataClient`. The UI is validated against this client and the Go
 * store (slice S2 of docs/specs/agent-data-model.md) is written to match its
 * behavior, so the semantics here are the real ones, not a stub.
 *
 * Layout: this file owns the store, latency, and delete tokens. The rules
 * live in the pure engine files next to it (`dataspaces.mock.*.ts`).
 */

import type { DataClient, DeleteKind } from "./dataspaces";
import { type FixtureSeed, resolveFixtureSeed } from "./dataspaces.fixtures";
import {
  applyDelete,
  DELETE_TOKEN_TTL_MS,
  normalizeIds,
  planDelete,
} from "./dataspaces.mock.delete";
import { queryRecords } from "./dataspaces.mock.query";
import {
  createRecord,
  linkRecords,
  unlinkRecords,
  updateRecord,
} from "./dataspaces.mock.records";
import {
  addAttribute,
  createObjectType,
  updateAttribute,
  updateObjectType,
} from "./dataspaces.mock.schema";
import {
  ACTOR_HUMAN,
  createRecordViewer,
  deepClone,
  fail,
  type MockContext,
  requireRecord,
  type SpaceState,
  viewObjectType,
  viewSchema,
  viewSpace,
} from "./dataspaces.mock.store";
import { normalizeAccess } from "./dataspacesAccess";

export const DEFAULT_MOCK_DELAY_MS = 120;
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 8;

export interface MockDataClientOptions {
  /** Simulated latency per call. Tests pass 0. */
  delayMs?: number;
  /** Clock override, for timestamps and delete token expiry. */
  now?: () => Date;
  /** Stamped into `createdBy`. Defaults to "human", the operator. */
  actor?: string;
  /** Random token source, for ids. Override for deterministic tests. */
  mintToken?: () => string;
}

interface DeleteBinding {
  spaceId: string;
  kind: DeleteKind;
  ids: readonly string[];
  expiresAt: number;
}

function randomToken(): string {
  let token = "";
  for (let index = 0; index < TOKEN_LENGTH; index += 1) {
    token += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return token;
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function createMockDataClient(
  seed?: FixtureSeed,
  options: MockDataClientOptions = {},
): DataClient {
  const delayMs = options.delayMs ?? DEFAULT_MOCK_DELAY_MS;
  const mintToken = options.mintToken ?? randomToken;
  const ctx: MockContext = {
    actor: options.actor ?? ACTOR_HUMAN,
    now: options.now ?? (() => new Date()),
    mintId: (prefix) => `${prefix}_${mintToken()}`,
  };

  // Each client owns deep copies, so two clients never share state.
  let spaces = new Map<string, SpaceState>(
    resolveFixtureSeed(seed).map((space) => [space.space.id, space]),
  );
  let deleteTokens = new Map<string, DeleteBinding>();

  const load = (spaceId: string): SpaceState => {
    const state = spaces.get(spaceId);
    if (!state) {
      const known = [...spaces.keys()].join(", ");
      return fail(`Unknown data space "${spaceId}". Known spaces: ${known}.`);
    }
    return state;
  };

  /** Swaps in the next snapshot. An unchanged snapshot is a no-op. */
  const commit = (previous: SpaceState, next: SpaceState): SpaceState => {
    if (next === previous) return previous;
    const updatedAt = ctx.now().toISOString();
    const stamped = { ...next, space: { ...next.space, updatedAt } };
    spaces = new Map(spaces).set(stamped.space.id, stamped);
    return stamped;
  };

  return {
    async listSpaces() {
      await wait(delayMs);
      return [...spaces.values()].map(viewSpace);
    },

    async getSchema(spaceId) {
      await wait(delayMs);
      return viewSchema(load(spaceId));
    },

    async updateSpaceAccess(spaceId, access) {
      await wait(delayMs);
      const state = load(spaceId);
      // Normalized before anything is written, so a bad grant changes nothing.
      const next = normalizeAccess(state.space.owner, access);
      const space = { ...state.space, access: next };
      return viewSpace(commit(state, { ...state, space }));
    },

    async createObjectType(spaceId, input) {
      await wait(delayMs);
      const state = load(spaceId);
      const out = createObjectType(state, ctx, input);
      return viewObjectType(commit(state, out.state), out.result);
    },

    async updateObjectType(spaceId, typeId, patch) {
      await wait(delayMs);
      const state = load(spaceId);
      const out = updateObjectType(state, typeId, patch);
      return viewObjectType(commit(state, out.state), out.result);
    },

    async addAttribute(spaceId, typeId, input) {
      await wait(delayMs);
      const state = load(spaceId);
      const out = addAttribute(state, ctx, typeId, input);
      commit(state, out.state);
      return deepClone(out.result);
    },

    async updateAttribute(spaceId, typeId, attributeId, patch) {
      await wait(delayMs);
      const state = load(spaceId);
      const out = updateAttribute(state, ctx, typeId, attributeId, patch);
      commit(state, out.state);
      return deepClone(out.result);
    },

    async queryRecords(spaceId, query) {
      await wait(delayMs);
      return queryRecords(load(spaceId), query);
    },

    async getRecord(spaceId, recordId) {
      await wait(delayMs);
      const state = load(spaceId);
      return createRecordViewer(state)(requireRecord(state, recordId));
    },

    async createRecord(spaceId, typeId, values) {
      await wait(delayMs);
      const state = load(spaceId);
      const out = createRecord(state, ctx, typeId, values);
      return createRecordViewer(commit(state, out.state))(out.record);
    },

    async updateRecord(spaceId, recordId, values) {
      await wait(delayMs);
      const state = load(spaceId);
      const out = updateRecord(state, ctx, recordId, values);
      return createRecordViewer(commit(state, out.state))(out.record);
    },

    async linkRecords(spaceId, recordId, attributeSlug, targetId, replace) {
      await wait(delayMs);
      const state = load(spaceId);
      const out = linkRecords(
        state,
        ctx,
        recordId,
        attributeSlug,
        targetId,
        replace === true,
      );
      return createRecordViewer(commit(state, out.state))(out.record);
    },

    async unlinkRecords(spaceId, recordId, attributeSlug, targetId) {
      await wait(delayMs);
      const state = load(spaceId);
      const out = unlinkRecords(state, ctx, recordId, attributeSlug, targetId);
      return createRecordViewer(commit(state, out.state))(out.record);
    },

    async previewDelete(spaceId, kind, ids) {
      await wait(delayMs);
      const plan = planDelete(load(spaceId), kind, ids);
      const token = `del_${mintToken()}${mintToken()}`;
      deleteTokens = new Map(deleteTokens).set(token, {
        spaceId,
        kind,
        ids: normalizeIds(ids),
        expiresAt: ctx.now().getTime() + DELETE_TOKEN_TTL_MS,
      });
      return { token, kind, impact: { ...plan.impact } };
    },

    async executeDelete(spaceId, token) {
      await wait(delayMs);
      const binding = deleteTokens.get(token);
      if (!binding || binding.spaceId !== spaceId) {
        return fail("Unknown delete token. Run the delete preview again.");
      }
      // A token is single use, whether it succeeds, fails, or has expired.
      const remaining = new Map(deleteTokens);
      remaining.delete(token);
      deleteTokens = remaining;
      if (ctx.now().getTime() > binding.expiresAt) {
        return fail("This delete token has expired. Run the preview again.");
      }
      const state = load(spaceId);
      // Re-planned against current state, so a stale id set fails loudly.
      const next = applyDelete(
        state,
        planDelete(state, binding.kind, binding.ids),
      );
      if (next === null) {
        const rest = new Map(spaces);
        rest.delete(spaceId);
        spaces = rest;
        return;
      }
      commit(state, next);
    },
  };
}
