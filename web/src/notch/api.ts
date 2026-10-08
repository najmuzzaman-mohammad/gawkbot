import { get, post } from "../api/client";
import type { NotchState } from "./types";

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
