// Wire types for GET /notch/state. Mirrors internal/team/broker_notch.go;
// keep the Mood strings in lockstep with the Mood* constants there.

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
}

export interface NotchOption {
  id: string;
  label: string;
  requires_text?: boolean;
}

export interface NotchAttention {
  id: string;
  kind: string;
  from: string;
  from_name?: string;
  channel?: string;
  title?: string;
  question: string;
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
}
