import { get, post } from "../api/client";
import { isInMacApp, postNative } from "./bridge";
import type { NotchState } from "./types";

export const NOTCH_QUERY_KEY = ["notch-state"] as const;

/**
 * The state poll. While the panel is open it says so (open=1): that is the
 * only time the broker reads what is in front of the owner, and it stops
 * as soon as the open polls stop.
 */
export function notchStatePath(open: boolean) {
  return open ? "/notch/state?open=1" : "/notch/state";
}

export function getNotchState(open = false) {
  return get<NotchState>(notchStatePath(open));
}

/** One picture of the display, because the person asked. Owner only. */
export function captureScreen() {
  return post<{ data_url: string; width: number; height: number }>(
    "/notch/screen/capture",
    {},
  );
}

/**
 * Asks macOS for a grant. Inside the Mac app the prompt is the app's own,
 * whichever process serves the office; elsewhere the broker is asked, and
 * answers only when it runs inside the app.
 */
export function requestPermission(kind: "accessibility" | "screen_recording") {
  if (isInMacApp()) {
    postNative({ type: "permission", kind });
    return Promise.resolve();
  }
  return post("/notch/permissions/request", { kind }).then(() => undefined);
}

/** The notch card id of a bot waiting to be allowed onto this Mac. */
export const CONSENT_CARD_PREFIX = "consent:";

/**
 * Answers a pending request with one of its options (same path as the
 * Inbox). A consent card is not a request: its answer goes to the
 * computer's control, and the card leaves on the next poll.
 */
export function answerRequest(id: string, choiceId: string) {
  if (id.startsWith(CONSENT_CARD_PREFIX)) {
    const slug = id.slice(CONSENT_CARD_PREFIX.length);
    return post(`/computer/${encodeURIComponent(slug)}/control`, {
      action: choiceId,
    });
  }
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

/** Marks a finished turn done without answering it. */
export function markFinishedSeen(id: string) {
  return post("/notch/finished/seen", { id });
}

/** Opens a terminal session where it runs (its terminal, or Codex). */
export function showSession(slug: string) {
  return post("/agents/local/sessions/show", { slug });
}

/**
 * Stops one bot's running turns, from its card at the top right. The
 * office keeps going: only that bot stops, and it takes its next message
 * as usual. Owner only.
 */
export function stopBot(slug: string) {
  return post("/notch/stop", { slug }).then(() => undefined);
}

/** The newest line of a thread was on screen: it is read. Owner only. */
export function markRead(channel: string, messageId: string) {
  return post("/notch/read", { channel, message_id: messageId }).then(
    () => undefined,
  );
}
