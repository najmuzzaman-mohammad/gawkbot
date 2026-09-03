import { create } from "zustand";

import type { ComputerEventPayload } from "../api/computer";
import {
  __internal as botEventTimerInternal,
  computePillState,
  type PillState,
} from "../lib/botEventTimer";
import { DEFAULT_THEME, isTheme, type Theme } from "../lib/themes";
import {
  applyComputerEvent,
  type ComputerLiveState,
  type ComputerRuntimeBuild,
  EMPTY_COMPUTER_RUNTIME_BUILD,
} from "./computerState";

export { MAX_COMPUTER_BUILD_LINES } from "./computerState";
export type { ComputerLiveState, ComputerRuntimeBuild, Theme };

/**
 * Snapshot payload for the SSE "activity" event. Lane A may not yet emit
 * `kind`; consumers must default to "routine". Lane A omits the field when
 * the classifier hasn't run, which is acceptable.
 */
export interface BotActivitySnapshot {
  slug: string;
  status?: string;
  activity?: string;
  detail?: string;
  lastTime?: string;
  totalMs?: number;
  firstEventMs?: number;
  firstTextMs?: number;
  firstToolMs?: number;
  kind?: "routine" | "milestone" | "stuck";
}

/**
 * Stored snapshot — extends the wire payload with client-side timestamps used
 * to drive halo decay and idle/dim transitions.
 */
export interface StoredActivitySnapshot extends BotActivitySnapshot {
  /** Wall-clock ms when this snapshot was received by the client. */
  receivedAtMs: number;
  /**
   * Wall-clock ms after which the halo glow expires. Stuck snapshots leave
   * this at the previous value (no false halo on stuck).
   */
  haloUntilMs: number;
}

const { HALO_DECAY_MS } = botEventTimerInternal;

/**
 * Cap on per-slug history depth in botActivityHistory. The Tier 2 hover
 * peek surfaces the most recent ≤6 prior events; the buffer holds 8 so the
 * peek has a small forward margin if display rules change.
 */
export const MAX_AGENT_HISTORY = 8;

const _storedTheme = ((): Theme => {
  try {
    const v = localStorage.getItem("wuphf-theme");
    if (isTheme(v)) return v;
  } catch {}
  return DEFAULT_THEME;
})();
if (typeof document !== "undefined") {
  document.documentElement.setAttribute("data-theme", _storedTheme);
}

interface SidebarSectionsState {
  agents: boolean;
  channels: boolean;
  // Tasks group, between Channels and Tools.
  tasks: boolean;
  apps: boolean;
}

const SIDEBAR_SECTIONS_KEY = "wuphf-sidebar-sections";

const _storedSidebarSections = ((): SidebarSectionsState => {
  // v3 MVP (2026-05-25 product call): Channels are first-class and open
  // by default. Chat is the primary surface; the bot subspace is an
  // additional view. Existing sessions keep whatever value they previously
  // persisted.
  const def: SidebarSectionsState = {
    agents: true,
    channels: true,
    tasks: true,
    apps: true,
  };
  try {
    const raw = localStorage.getItem(SIDEBAR_SECTIONS_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Partial<SidebarSectionsState>;
    return {
      agents: parsed.agents ?? def.agents,
      channels: parsed.channels ?? def.channels,
      tasks: parsed.tasks ?? def.tasks,
      apps: parsed.apps ?? def.apps,
    };
  } catch {
    return def;
  }
})();

function persistSidebarSections(state: SidebarSectionsState): void {
  try {
    localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(state));
  } catch {}
}

// directChannelSlug moved to lib/channels.ts so the API layer can build a DM
// slug without importing this store. Re-exported here because a dozen
// components import it from this module.
export { botHomeChannel, directChannelSlug } from "../lib/channels";

/**
 * Sentinel "channel" the onboarding wizard seeds the first-issue draft under so
 * the home composer (TaskComposer) picks it up on landing. It is NOT a real
 * channel slug — the leading "@" can never collide with one — so the #general
 * ConversationView Composer can't consume the handoff out from under the home
 * surface the founder actually lands on.
 */
export const HOME_COMPOSER_DRAFT_CHANNEL = "@home";

export interface AppBuilderDialogState {
  mode: "create" | "update";
  /** Set in "update" mode — the app being improved. */
  appId?: string;
  /** App name, prefilled in "update" mode for display. */
  name?: string;
  /**
   * Optional prefill for the description textarea. "Select to edit" seeds a
   * concise instruction stub (e.g. the element + its source location) so the
   * human only types the actual change.
   */
  seed?: string;
}

export interface AppStore {
  // Connection
  brokerConnected: boolean;
  setBrokerConnected: (v: boolean) => void;

  // Theme
  theme: Theme;
  setTheme: (t: Theme) => void;

  // Sidebar
  sidebarBotsOpen: boolean;
  toggleSidebarBots: () => void;
  sidebarChannelsOpen: boolean;
  toggleSidebarChannels: () => void;
  /** Tasks group open/closed state. */
  sidebarTasksOpen: boolean;
  toggleSidebarTasks: () => void;
  sidebarAppsOpen: boolean;
  toggleSidebarApps: () => void;
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;

  // Thread panel — captures the originating channel alongside the message id
  // so that replies posted while the user has navigated away from the channel
  // (e.g. into /apps/console) still land in the channel where the thread
  // started, instead of the URL's current fallback channel.
  activeThread: { id: string; channelSlug: string } | null;
  setActiveThread: (thread: { id: string; channelSlug: string } | null) => void;

  // Last channel/dm the user visited. Held as a session-scoped fallback so
  // off-conversation surfaces (Console, Requests, sidebar request badge) can
  // surface the user's working channel rather than always defaulting to
  // #general when `useChannelSlug()` is null. Updated from the route effect
  // in MainContent.
  lastConversationalChannel: string | null;
  setLastConversationalChannel: (channelSlug: string | null) => void;

  // Per-thread collapsed state in the main feed. The key is the parent
  // message id. Default is expanded (entry absent or false); toggling
  // stores `true` so the inline replies hide.
  collapsedThreads: Record<string, boolean>;
  toggleThreadCollapsed: (parentId: string) => void;

  // Message polling state
  lastMessageId: string | null;
  setLastMessageId: (id: string | null) => void;
  clearedMessageIdsByChannel: Record<string, string>;
  setChannelClearMarker: (channel: string, messageId: string | null) => void;
  unreadByChannel: Record<string, number>;
  incrementUnread: (channel: string) => void;
  clearUnread: (channel: string) => void;

  // Bot panel
  activeBotSlug: string | null;
  setActiveBotSlug: (slug: string | null) => void;

  // Command palette — Cmd+K / Ctrl+K quick-jump surface
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (v: boolean) => void;

  // Deep search modal — full-text search across messages, wiki, notebooks
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  /**
   * Query to prefill in the SearchModal on next open. Set by the composer
   * `/search <query>` command and cleared by the modal when consumed.
   */
  composerSearchInitialQuery: string;
  setComposerSearchInitialQuery: (q: string) => void;

  /**
   * One-shot composer prefill keyed by channel. Set when a flow wants to drop
   * the user into a channel with text already in the box — for example, the
   * office tour finish handoff seeds an example first issue in the CEO DM.
   * The Composer consumes and clears it when its channel matches, so it never
   * re-applies on a later visit to the same channel.
   */
  pendingComposerDraft: { channel: string; text: string } | null;
  setPendingComposerDraft: (channel: string, text: string) => void;
  consumePendingComposerDraft: (channel: string) => string | null;

  // Help modal — /help slash command surface
  composerHelpOpen: boolean;
  setComposerHelpOpen: (v: boolean) => void;

  // Version modal — opened by the version chip in the StatusBar
  versionModalOpen: boolean;
  setVersionModalOpen: (v: boolean) => void;

  // /connect integration wizard. Bare /connect opens the provider picker
  // (mode = "provider", parity with the TUI's `/connect` 4-option picker).
  // `/connect telegram` skips the picker and lands on the Telegram token
  // step (mode = "telegram"). Other modes can be added when more
  // integrations get web wizards.
  telegramConnectOpen: boolean;
  telegramConnectMode: "provider" | "telegram";
  openConnectWizard: (mode: "provider" | "telegram") => void;
  setTelegramConnectOpen: (v: boolean) => void;

  // App Builder dialog: /create-app, /update-app, and the Edit button on an
  // app screen open this NL-description dialog, which kicks off an App Builder
  // task. null when closed.
  appBuilderDialog: AppBuilderDialogState | null;
  openCreateAppDialog: () => void;
  openUpdateAppDialog: (appId: string, name?: string, seed?: string) => void;
  closeAppBuilderDialog: () => void;

  // Task modal: the ONE surface every task affordance opens. A task card in
  // the chat stream, a board row, a sub-task row, an inline `DUNDE-72`
  // reference — all of them set this id instead of navigating, because a
  // task is not a doorway to a chat room (the office channel owns the
  // conversation now). Holds the task id, or null when closed. Global rather
  // than prop-drilled because the call sites live in a dozen unrelated
  // subtrees; TaskModalHost (mounted once in RootRoute) reads it.
  taskModalTaskId: string | null;
  openTaskModal: (taskId: string) => void;
  closeTaskModal: () => void;

  // Optimistic "building…" rows for the Apps sidebar: a 20-60s App Builder
  // build would otherwise be dead air between submit and the app appearing.
  // Keyed by lowercased app name -> { display name, started-at epoch ms }.
  appBuilds: Record<string, { name: string; startedAt: number }>;
  noteAppBuilding: (name: string) => void;
  clearAppBuilding: (name: string) => void;

  // Onboarding
  onboardingComplete: boolean;
  setOnboardingComplete: (v: boolean) => void;
  resetForOnboarding: () => void;

  // Bot activity (SSE-driven event bubbles)
  botActivitySnapshots: Record<string, StoredActivitySnapshot>;
  // Per-slug ring buffer of prior snapshots, newest-first, capped at
  // MAX_AGENT_HISTORY. Powers the Tier 2 hover-peek "Recent" list. The
  // current snapshot lives in botActivitySnapshots; history holds only
  // what was previously current and got displaced by a newer event.
  botActivityHistory: Record<string, StoredActivitySnapshot[]>;
  recordActivitySnapshot: (snap: BotActivitySnapshot) => void;

  // SSE reconnect grace — true after the EventSource has stayed in a
  // not-OPEN state for >5s. Drives the row-dim + bottom-of-rail
  // "Reconnecting…" indicator (eng decision A3).
  isReconnecting: boolean;
  setIsReconnecting: (v: boolean) => void;

  // Bot computers (SSE `computer` events, docs/specs/gawkbot-bot-computers.md).
  // Per-slug live state: the latest frame, who holds the wheel, and the
  // lifecycle state. The Computer tab merges its 5s status poll into this
  // record too, so every surface (tab, chat thumbnails, sidebar glyph)
  // reads one truth.
  computerStates: Record<string, ComputerLiveState>;
  // Machine-wide desktop-image build: events arrive with slug "".
  computerRuntimeBuild: ComputerRuntimeBuild;
  recordComputerEvent: (payload: ComputerEventPayload) => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  brokerConnected: false,
  setBrokerConnected: (v) => set({ brokerConnected: v }),

  theme: _storedTheme,
  setTheme: (t) => {
    // Same try/catch shape as the read path above. Safari private browsing
    // and sandboxed-iframe contexts both throw on localStorage writes; the
    // toggle should still update the DOM + store even if persistence fails,
    // so the user gets the visible state change for the current session.
    // console.warn keeps a breadcrumb so a user reporting "theme doesn't
    // stick" has something diagnosable in DevTools.
    try {
      localStorage.setItem("wuphf-theme", t);
    } catch (err) {
      console.warn(
        "setTheme: localStorage.setItem failed; theme will not persist across reloads",
        err,
      );
    }
    document.documentElement.setAttribute("data-theme", t);
    set({ theme: t });
  },

  sidebarBotsOpen: _storedSidebarSections.agents,
  toggleSidebarBots: () => {
    const next = !get().sidebarBotsOpen;
    set({ sidebarBotsOpen: next });
    persistSidebarSections({
      agents: next,
      channels: get().sidebarChannelsOpen,
      tasks: get().sidebarTasksOpen,
      apps: get().sidebarAppsOpen,
    });
  },
  sidebarChannelsOpen: _storedSidebarSections.channels,
  toggleSidebarChannels: () => {
    const next = !get().sidebarChannelsOpen;
    set({ sidebarChannelsOpen: next });
    persistSidebarSections({
      agents: get().sidebarBotsOpen,
      channels: next,
      tasks: get().sidebarTasksOpen,
      apps: get().sidebarAppsOpen,
    });
  },
  sidebarTasksOpen: _storedSidebarSections.tasks,
  toggleSidebarTasks: () => {
    const next = !get().sidebarTasksOpen;
    set({ sidebarTasksOpen: next });
    persistSidebarSections({
      agents: get().sidebarBotsOpen,
      channels: get().sidebarChannelsOpen,
      tasks: next,
      apps: get().sidebarAppsOpen,
    });
  },
  sidebarAppsOpen: _storedSidebarSections.apps,
  toggleSidebarApps: () => {
    const next = !get().sidebarAppsOpen;
    set({ sidebarAppsOpen: next });
    persistSidebarSections({
      agents: get().sidebarBotsOpen,
      channels: get().sidebarChannelsOpen,
      tasks: get().sidebarTasksOpen,
      apps: next,
    });
  },
  sidebarCollapsed: false,
  toggleSidebarCollapsed: () =>
    set({ sidebarCollapsed: !get().sidebarCollapsed }),

  activeThread: null,
  setActiveThread: (thread) => set({ activeThread: thread }),

  lastConversationalChannel: null,
  setLastConversationalChannel: (channelSlug) => {
    if (get().lastConversationalChannel === channelSlug) return;
    set({ lastConversationalChannel: channelSlug });
  },

  collapsedThreads: {},
  toggleThreadCollapsed: (parentId) =>
    set((s) => ({
      collapsedThreads: {
        ...s.collapsedThreads,
        [parentId]: !s.collapsedThreads[parentId],
      },
    })),

  lastMessageId: null,
  setLastMessageId: (id) => set({ lastMessageId: id }),
  clearedMessageIdsByChannel: {},
  setChannelClearMarker: (channel, messageId) => {
    // No "general" fallback. These maps are keyed BY channel; an empty slug
    // has no channel to key on, so filing it under the lobby silently
    // attributes state to a room the message never came from -- and once
    // #general is retired, to a room that does not exist.
    const ch = channel.trim();
    if (!ch) return;
    const id = messageId?.trim() || "";
    set((state) => {
      const next = { ...state.clearedMessageIdsByChannel };
      if (id) next[ch] = id;
      else delete next[ch];
      return { clearedMessageIdsByChannel: next };
    });
  },
  unreadByChannel: {},
  incrementUnread: (channel) => {
    const ch = channel.trim();
    if (!ch) return;
    set((state) => ({
      unreadByChannel: {
        ...state.unreadByChannel,
        [ch]: (state.unreadByChannel[ch] ?? 0) + 1,
      },
    }));
  },
  clearUnread: (channel) => {
    const ch = channel.trim();
    if (!ch) return;
    set((state) => {
      if ((state.unreadByChannel[ch] ?? 0) === 0) return state;
      return {
        unreadByChannel: { ...state.unreadByChannel, [ch]: 0 },
      };
    });
  },

  activeBotSlug: null,
  setActiveBotSlug: (slug) => set({ activeBotSlug: slug }),

  commandPaletteOpen: false,
  setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),

  searchOpen: false,
  setSearchOpen: (v) => set({ searchOpen: v }),
  composerSearchInitialQuery: "",
  setComposerSearchInitialQuery: (q) => set({ composerSearchInitialQuery: q }),

  pendingComposerDraft: null,
  setPendingComposerDraft: (channel, text) =>
    set({ pendingComposerDraft: { channel, text } }),
  consumePendingComposerDraft: (channel) => {
    const pending = get().pendingComposerDraft;
    if (!pending || pending.channel !== channel) return null;
    set({ pendingComposerDraft: null });
    return pending.text;
  },

  composerHelpOpen: false,
  setComposerHelpOpen: (v) => set({ composerHelpOpen: v }),

  versionModalOpen: false,
  setVersionModalOpen: (v) => set({ versionModalOpen: v }),

  telegramConnectOpen: false,
  telegramConnectMode: "provider",
  openConnectWizard: (mode) =>
    set({ telegramConnectOpen: true, telegramConnectMode: mode }),
  setTelegramConnectOpen: (v) => set({ telegramConnectOpen: v }),

  appBuilderDialog: null,
  openCreateAppDialog: () => set({ appBuilderDialog: { mode: "create" } }),
  openUpdateAppDialog: (appId, name, seed) =>
    set({ appBuilderDialog: { mode: "update", appId, name, seed } }),
  closeAppBuilderDialog: () => set({ appBuilderDialog: null }),

  taskModalTaskId: null,
  // Empty / whitespace ids are ignored: a card whose payload lost its task_id
  // should stay inert rather than pop an un-loadable modal.
  openTaskModal: (taskId) => {
    const id = taskId.trim();
    if (!id) return;
    set({ taskModalTaskId: id });
  },
  closeTaskModal: () => set({ taskModalTaskId: null }),

  appBuilds: {},
  noteAppBuilding: (name) =>
    set((state) => ({
      appBuilds: {
        ...state.appBuilds,
        [name.trim().toLowerCase()]: {
          name: name.trim(),
          startedAt: Date.now(),
        },
      },
    })),
  clearAppBuilding: (name) =>
    set((state) => {
      const key = name.trim().toLowerCase();
      if (!(key in state.appBuilds)) return {};
      const next = { ...state.appBuilds };
      delete next[key];
      return { appBuilds: next };
    }),

  botActivitySnapshots: {},
  botActivityHistory: {},
  recordActivitySnapshot: (snap) => {
    if (typeof snap?.slug !== "string" || snap.slug.length === 0) return;
    const { slug } = snap;
    const now = Date.now();
    set((state) => {
      const previous = state.botActivitySnapshots[slug];
      // Stuck snapshots must NOT bump the halo window — a stuck transition
      // would otherwise visually read as "alive" via the halo glow. Preserve
      // the previous haloUntilMs (or default to a past value if none) so the
      // halo state derives correctly via computePillState.
      const haloUntilMs =
        snap.kind === "stuck"
          ? (previous?.haloUntilMs ?? 0)
          : now + HALO_DECAY_MS;
      // Push the previous current snapshot onto the per-slug history ring
      // buffer (newest-first). The current snapshot itself stays in
      // botActivitySnapshots; history holds only displaced events. First
      // event for a slug leaves history untouched (no previous to keep).
      const prevHistory = state.botActivityHistory[slug] ?? [];
      const nextHistory = previous
        ? [previous, ...prevHistory].slice(0, MAX_AGENT_HISTORY)
        : prevHistory;
      return {
        botActivitySnapshots: {
          ...state.botActivitySnapshots,
          [slug]: {
            ...snap,
            receivedAtMs: now,
            haloUntilMs,
          },
        },
        botActivityHistory: {
          ...state.botActivityHistory,
          [slug]: nextHistory,
        },
      };
    });
  },

  isReconnecting: false,
  setIsReconnecting: (v) => {
    if (get().isReconnecting === v) return;
    set({ isReconnecting: v });
  },

  computerStates: {},
  computerRuntimeBuild: EMPTY_COMPUTER_RUNTIME_BUILD,
  recordComputerEvent: (payload) => {
    const now = Date.now();
    set((state) => applyComputerEvent(state, payload, now));
  },

  onboardingComplete: false,
  setOnboardingComplete: (v) => set({ onboardingComplete: v }),
  resetForOnboarding: () =>
    set({
      unreadByChannel: {},
      activeThread: null,
      lastMessageId: null,
      clearedMessageIdsByChannel: {},
      activeBotSlug: null,
      lastConversationalChannel: null,
      commandPaletteOpen: false,
      searchOpen: false,
      composerSearchInitialQuery: "",
      composerHelpOpen: false,
      versionModalOpen: false,
      // Close the /connect wizard during an onboarding reset for the same
      // reason searchOpen / composerHelpOpen are: any modal left open here
      // would float over the onboarding flow.
      telegramConnectOpen: false,
      onboardingComplete: false,
    }),
}));

/**
 * Derive the current pill state for a bot slug at `nowMs`. When no
 * snapshot exists for that slug yet, returns "idle" so the pill renders the
 * Office-voice fallback copy. Pure function: relies entirely on the store
 * snapshot and the injected `nowMs`, so the same call site is deterministic
 * under test.
 */
export function selectPillState(
  state: Pick<AppStore, "botActivitySnapshots">,
  slug: string,
  nowMs: number,
): PillState {
  const snapshot = state.botActivitySnapshots[slug];
  if (!snapshot) {
    return "idle";
  }
  return computePillState({
    lastEventMs: snapshot.receivedAtMs,
    nowMs,
    kind: snapshot.kind,
    haloUntilMs: snapshot.haloUntilMs,
  });
}

export interface BotPeekData {
  current: StoredActivitySnapshot | undefined;
  history: StoredActivitySnapshot[];
}

// Stable empty-history reference so selectBotPeek does not allocate a fresh
// array on every call. Important if the selector is later subscribed via
// Zustand — equal references avoid spurious re-renders.
const EMPTY_AGENT_HISTORY: readonly StoredActivitySnapshot[] = Object.freeze(
  [],
);

/**
 * Read the current snapshot + per-slug history for the Tier 2 hover peek.
 * Returns an empty history array (not undefined) when nothing has streamed
 * past for that slug yet, so consumers can `.map` without a guard.
 */
export function selectBotPeek(
  state: Pick<AppStore, "botActivitySnapshots" | "botActivityHistory">,
  slug: string,
): BotPeekData {
  return {
    current: state.botActivitySnapshots[slug],
    history:
      state.botActivityHistory[slug] ??
      (EMPTY_AGENT_HISTORY as StoredActivitySnapshot[]),
  };
}
