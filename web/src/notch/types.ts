// Wire types for GET /notch/state. Mirrors internal/team/broker_notch.go;
// keep the Mood strings in lockstep with the Mood* constants there.

import type { MemberAvatar } from "../api/memberTypes";
import type { BotRuntime } from "../lib/botRuntime";

export type Mood = "working" | "idle" | "needs_you" | "error" | "done";

export interface NotchAgent {
  slug: string;
  name: string;
  mood: Mood;
  detail?: string;
  origin?: string;
  runs_on?: "this_machine" | "elsewhere";
  runs_on_detail?: string;
  is_lead?: boolean;
  /** The bot's chosen look; absent means the slug-derived one. */
  avatar?: MemberAvatar;
  /** What it runs on (tool and model), for the badge on its avatar. */
  runtime?: BotRuntime;
  /**
   * "session": an agent session found running on this Mac (a Claude Code or
   * Codex window the human opened), not an office bot. It is listed with
   * the bots, but it has no DM: the fields below say what it is doing.
   */
  kind?: "session";
  /** Which tool runs it: "claude-code", "codex". The row shows its logo. */
  tool?: string;
  tool_name?: string;
  /** The folder it is working in, and its full path. */
  project?: string;
  cwd?: string;
  state?: "working" | "your_turn" | "quiet";
  updated_at?: string;
  /** The end of its latest reply: what it is waiting on. */
  last_said?: string;
  /** Whether its window is open now. Absent means unknown; only Claude Code reports it. */
  open?: boolean;
  /**
   * The session is a member of the office and has a DM, so its row works
   * exactly like a bot's. Absent: it can only be read, not messaged.
   */
  can_message?: boolean;
  /** The bot's direct message with you, its newest line, and what is new. */
  channel?: string;
  last?: NotchBriefLine;
  unread?: number;
}

/** A reply the office suggests for a card; the first is the recommendation. */
export interface NotchSuggestion {
  label: string;
  /** Exactly what is sent when it is chosen. */
  reply: string;
}

export interface NotchOption {
  id: string;
  label: string;
  /** What choosing this would mean, in the asker's words. */
  description?: string;
  requires_text?: boolean;
}

/**
 * The full background for a question, shown when its card is opened (hover
 * or selection). Mirrors notchBrief in internal/team/broker_notch.go.
 */
export interface NotchBrief {
  /** The asker's decision brief, in full. */
  context?: string;
  /** The room the work lives in (never a DM), and what it is for. */
  project?: string;
  project_about?: string;
  /** The piece of work the question came out of. */
  task?: { title: string; details?: string; status?: string };
  asker_role?: string;
  /** The last few lines of that room, oldest first. */
  recent?: NotchBriefLine[];
}

/** One line of a conversation, as the notch quotes it. */
export interface NotchBriefLine {
  from: string;
  name?: string;
  text: string;
  at?: string;
}

/** What a finished turn's work is about and where it stands. */
export interface NotchRecap {
  project?: string;
  /** The request the work opened with. */
  asked?: string;
  /** The latest request, when it is not the opening one. */
  last_asked?: string;
  /** The latest reply in full, line breaks kept. */
  reply?: string;
  /** The turn before, when the latest reply is too short to stand alone. */
  earlier?: string;
}

export interface NotchAttention {
  id: string;
  kind: string;
  from: string;
  from_name?: string;
  channel?: string;
  title?: string;
  question: string;
  /** The asker's decision brief: what it was doing, what it found, why it asks. */
  context?: string;
  brief?: NotchBrief;
  options?: NotchOption[];
  recommended_id?: string;
  blocking?: boolean;
  created_at?: string;
  /** Set on a finished turn. */
  recap?: NotchRecap;
  /** Replies to choose from, recommended first. Absent until written. */
  suggestions?: NotchSuggestion[];
  /** True while those replies are being written. */
  suggestions_pending?: boolean;
}

/** What the owner has in front of them, only while the notch is open. */
export interface NotchScreen {
  app: string;
  bundle_id?: string;
  window_title?: string;
  url?: string;
  domain?: string;
}

/** The macOS grants the app holds. */
export interface NotchPermissions {
  accessibility: boolean;
  screen_recording: boolean;
}

/** Which features the notch may offer right now. */
export interface NotchCapabilities {
  voice_realtime: boolean;
  screen_context: boolean;
  screen_capture: boolean;
  pointer: boolean;
  mac_computer: boolean;
}

/** A box on the screen, in global points with the origin at the top-left. */
export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One drawing on the screen (internal/hostcomputer/scene.go). */
export interface OverlayItem {
  kind: "pointer" | "label" | "arrow" | "circle" | "box";
  x?: number;
  y?: number;
  text?: string;
  label?: string;
  color?: string;
  from?: OverlayRect;
  to?: OverlayRect;
  rect?: OverlayRect;
}

/** What to draw over the screen; it fades after ttl_ms. */
export interface OverlayScene {
  id?: string;
  ttl_ms?: number;
  color?: string;
  items: OverlayItem[];
}

/** The drawing waiting for the app: a new seq means draw (or clear when the scene is null). */
export interface NotchOverlay {
  seq: number;
  scene: OverlayScene | null;
}

export interface NotchState {
  lead?: string;
  lead_name?: string;
  lead_dm?: string;
  /**
   * The end of the owner's conversation with the lead, oldest first, for
   * the lead's own chat box. Absent for anyone but the owner.
   */
  lead_recent?: NotchBriefLine[];
  mood: Mood;
  headline: string;
  agents: NotchAgent[];
  attention: NotchAttention[];
  /**
   * Every turn that ended and is waiting on the human (kind "finished"),
   * newest first. Not open requests: reply by message, or mark done.
   * Absent from a broker too old to send it.
   */
  finished?: NotchAttention[];
  /**
   * The person's one switch (Settings, Notch) for bots leaving the notch to
   * get attention. Only an explicit false turns it off; a broker too old to
   * send it means on.
   */
  jump_out?: boolean;
  /** Bots speak up out loud when they need you or finish. On unless false. */
  announce?: boolean;
  /**
   * The app and window in front of the owner, read a second at a time only
   * while the notch says it is open (the poll's open=1), never stored.
   * Owner only, Mac app only.
   */
  screen?: NotchScreen;
  /** The macOS grants the app holds. Owner only, Mac app only. */
  permissions?: NotchPermissions;
  /** What the notch may offer. Owner only. */
  capabilities?: NotchCapabilities;
  /** A drawing waiting for the Mac app's screen. Owner only. */
  overlay?: NotchOverlay;
  /** A bot is set to run on this Mac, so its grants are worth asking for. */
  host_wanted?: boolean;
  /** The integration behind what is in front, not connected yet. Owner only. */
  hint?: NotchHint;
  /** The office's ideas for new bots, from its daily look. Owner only. */
  ideas?: NotchIdeas;
}

/** One thing the daily look saw, cited by an idea. */
export interface NotchIdeaEvidence {
  id: string;
  platform: string;
  text: string;
}

/** A proposed bot: who it would be, what it promises, and why now. */
export interface NotchIdea {
  id: string;
  fingerprint: string;
  name: string;
  role: string;
  integration: string;
  integration_name: string;
  logo_url?: string;
  promise: string;
  rationale: string;
  cadence?: string;
  cadence_label?: string;
  first_task: string;
  evidence?: NotchIdeaEvidence[];
  avatar?: MemberAvatar;
  created_at: string;
  seen_count?: number;
}

export interface NotchIdeas {
  enabled: boolean;
  checked_at?: string;
  next_at?: string;
  scanning?: boolean;
  items: NotchIdea[];
}

/** A quiet offer to connect the integration behind the app or page in front. */
export interface NotchHint {
  platform: string;
  name: string;
  logo_url?: string;
  line: string;
  since: string;
}

/** Physical notch geometry, in CSS px, handed over by the native shell. */
export interface NotchGeometry {
  /** Width of the camera housing. 0 on Macs without a notch. */
  notchWidth: number;
  /** Height of the notch (or the menu bar on notch-less Macs). */
  notchHeight: number;
  /**
   * Width of each "ear" that grows out beside the notch. Compact (under 60)
   * on Macs with a notch, so the ears hug it and the menu bar stays clear.
   */
  earWidth: number;
  /**
   * A thin band under the notch for the row of dots at rest. 0 unless the
   * page has decided to show them; never part of the shell's measurement.
   */
  band: number;
  /**
   * The host draws the open sheet's material (real system glass behind
   * the page), so the page paints a tint instead of an opaque sheet.
   */
  nativeGlass?: boolean;
  /** The open panel's size; the Mac app fits it to the screen. */
  expandedWidth?: number;
  expandedHeight?: number;
  /**
   * The global shortcut that opens the notch: "alt" (⌥Space), "ctrl-alt"
   * (⌃⌥Space), "" when none could be registered, absent outside the app.
   */
  hotkey?: NotchHotkey;
}

export type NotchHotkey = "alt" | "ctrl-alt" | "";
