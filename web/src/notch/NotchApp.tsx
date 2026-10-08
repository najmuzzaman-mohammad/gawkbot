import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  answerRequest,
  getNotchState,
  messageChiefOfStaff,
  NOTCH_QUERY_KEY,
} from "./api";
import { installNativeReceiver, postNative, readGeometry } from "./bridge";
import { NotchView } from "./NotchView";
import type { NotchState } from "./types";

const POLL_MS = 2_000;

/**
 * Ids of attention items that were not in `prev`. The first snapshot only
 * seeds `prev`, so opening the app with three old asks pending does not
 * buzz three times.
 */
export function newAttentionIds(
  prev: ReadonlySet<string> | null,
  state: NotchState,
): string[] {
  if (prev === null) return [];
  return state.attention.map((a) => a.id).filter((id) => !prev.has(id));
}

export function NotchApp({
  search = window.location.search,
}: {
  search?: string;
}) {
  const queryClient = useQueryClient();
  const [geometry] = useState(() => readGeometry(search));
  const [expanded, setExpanded] = useState(false);
  const [answering, setAnswering] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const uninstall = installNativeReceiver(setExpanded);
    postNative({ type: "ready" });
    return uninstall;
  }, []);

  const query = useQuery({
    queryKey: NOTCH_QUERY_KEY,
    queryFn: getNotchState,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });
  const state = query.data ?? null;

  // Tell the native shell when something NEW needs the human: it taps the
  // trackpad and peeks the notch open. That is the whole notification.
  useEffect(() => {
    if (!state) return;
    const fresh = newAttentionIds(seen.current, state);
    seen.current = new Set(state.attention.map((a) => a.id));
    if (fresh.length > 0) {
      postNative({
        type: "attention",
        count: state.attention.length,
        headline: state.headline,
      });
    }
  }, [state]);

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: NOTCH_QUERY_KEY });

  const answer = useMutation({
    mutationFn: ({ id, choiceId }: { id: string; choiceId: string }) =>
      answerRequest(id, choiceId),
    onMutate: ({ id }) => {
      setError(null);
      setAnswering((s) => new Set(s).add(id));
    },
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Could not send that answer",
      ),
    onSettled: (_d, _e, { id }) => {
      setAnswering((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      refresh();
    },
  });

  const send = useMutation({
    mutationFn: (text: string) => {
      if (!state?.lead_dm) {
        return Promise.reject(
          new Error("The Chief of Staff is not reachable yet"),
        );
      }
      return messageChiefOfStaff(state.lead_dm, text);
    },
    onMutate: () => setError(null),
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Could not send that message",
      ),
    onSuccess: refresh,
  });

  return (
    <NotchView
      state={state}
      geometry={geometry}
      expanded={expanded}
      answering={answering}
      sending={send.isPending}
      error={error ?? (query.isError ? "Lost the office. Retrying…" : null)}
      onAnswer={(id, choiceId) => answer.mutate({ id, choiceId })}
      onSend={(text) => send.mutate(text)}
      onOpen={(path) => postNative({ type: "open", path })}
      onKeyboard={(active) => postNative({ type: "keyboard", active })}
    />
  );
}
