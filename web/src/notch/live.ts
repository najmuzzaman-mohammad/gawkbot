import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { openSharedEventStream } from "../api/eventStream";
import { NOTCH_QUERY_KEY } from "./api";
import { THREAD_QUERY_PREFIX } from "./NotchThread";

/**
 * The notch learns of changes the moment they happen, from the office's
 * one event stream (`/events`), instead of two seconds later from the
 * poll. Every event that can move the notch (a message, an action such as
 * a card created or answered, a bot's activity, the office changing, a
 * computer, the governor) refetches the state, a few at a time. The poll
 * stays as the fallback and as the open notch's heartbeat: while open it
 * keeps polling every two seconds, which is what lets the office read the
 * screen; closed and live, it polls rarely.
 */
export const LIVE_EVENTS = [
  "message",
  "action",
  "activity",
  "office_changed",
  "computer",
  "governor",
] as const;

export const LIVE_DEBOUNCE_MS = 150;
/** The poll while the notch is open, or when the stream is not there. */
export const POLL_MS = 2_000;
/** The poll while closed and live: a safety net, not the source. */
export const POLL_LIVE_MS = 15_000;

export function pollInterval(expanded: boolean, live: boolean): number {
  return expanded || !live ? POLL_MS : POLL_LIVE_MS;
}

/** Joins the stream; returns whether it is connected right now. */
export function useNotchLive(queryClient: QueryClient): boolean {
  const [live, setLive] = useState(false);
  useEffect(() => {
    const stream = openSharedEventStream();
    if (!stream) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: NOTCH_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: [THREAD_QUERY_PREFIX] });
      }, LIVE_DEBOUNCE_MS);
    };
    const up = () => setLive(true);
    stream.addEventListener("open", up);
    stream.addEventListener("ready", up);
    for (const name of LIVE_EVENTS) stream.addEventListener(name, refresh);
    stream.onerror = () => setLive(false);
    return () => {
      if (timer) clearTimeout(timer);
      stream.close();
    };
  }, [queryClient]);
  return live;
}
