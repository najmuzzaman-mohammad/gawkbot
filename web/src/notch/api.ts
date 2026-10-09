import { get, post } from "../api/client";
import type { NotchSession, NotchState } from "./types";

export const NOTCH_QUERY_KEY = ["notch-state"] as const;

export function getNotchState() {
  return get<NotchState>("/notch/state");
}

/** Answers a pending request with one of its options (same path as the Inbox). */
export function answerRequest(id: string, choiceId: string) {
  return post("/requests/answer", { id, choice_id: choiceId });
}

/** Answers a pending request in words (typed or spoken). */
export function answerWithText(id: string, customText: string) {
  return post("/requests/answer", { id, custom_text: customText });
}

/** Posts the human's message into a DM, exactly as the app's composer does. */
export function sendMessage(channel: string, content: string) {
  return post("/messages", { from: "you", channel, content });
}

export const NOTCH_SESSIONS_KEY = ["notch-sessions"] as const;

/**
 * The agent sessions running on this Mac, each named by what it is doing.
 * Owner-only on the broker; an office that cannot answer (an older one, or
 * a joined human) simply has none to show.
 */
export async function getLocalSessions(): Promise<NotchSession[]> {
  try {
    const res = await get<{ sessions?: NotchSession[] }>(
      "/agents/local/sessions",
    );
    return res.sessions ?? [];
  } catch {
    return [];
  }
}
