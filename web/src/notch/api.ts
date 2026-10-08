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

/** Sends the human's note to the Chief of Staff's DM, as the composer does. */
export function messageChiefOfStaff(leadDM: string, content: string) {
  return post("/messages", { from: "you", channel: leadDM, content });
}
