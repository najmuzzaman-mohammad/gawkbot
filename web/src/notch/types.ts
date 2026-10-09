// Wire types for GET /notch/state. Mirrors internal/team/broker_notch.go;
// keep the Mood strings in lockstep with the Mood* constants there.

import type { MemberAvatar } from "../api/memberTypes";

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
  recent?: { from: string; name?: string; text: string; at?: string }[];
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
}

export interface NotchState {
  lead?: string;
  lead_name?: string;
  lead_dm?: string;
  mood: Mood;
  headline: string;
  agents: NotchAgent[];
  attention: NotchAttention[];
}

/** Physical notch geometry, in CSS px, handed over by the native shell. */
export interface NotchGeometry {
  /** Width of the camera housing. 0 on Macs without a notch. */
  notchWidth: number;
  /** Height of the notch (or the menu bar on notch-less Macs). */
  notchHeight: number;
  /** Width of each "ear" that grows out beside the notch. */
  earWidth: number;
  /**
   * The host draws the open sheet's material (real system glass behind
   * the page), so the page paints a tint instead of an opaque sheet.
   */
  nativeGlass?: boolean;
}
