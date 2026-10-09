import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { boredom as boredomOf, gang as gangOf } from "./antics";
import {
  answerRequest,
  answerWithText,
  getNotchState,
  NOTCH_QUERY_KEY,
  sendMessage,
} from "./api";
import {
  installNativeReceiver,
  isInMacApp,
  postNative,
  readGeometry,
} from "./bridge";
import {
  useArrival,
  useAttentionSignals,
  useBanter,
  useNotchKeys,
  usePeeks,
  useVoice,
} from "./hooks";
import type { ComposerState, ReplyTarget } from "./NotchPanel";
import { stageHeight } from "./NotchStrip";
import { NotchView } from "./NotchView";
import { play, setSoundEnabled, soundEnabled, unlock } from "./sounds";
import { deliverNativeVoice, voiceAvailable } from "./voice";

export { moodTransitions, newAttentionIds } from "./hooks";

const POLL_MS = 2_000;

function useGestureUnlock(): void {
  useEffect(() => {
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
}

/** A 1s clock that only ticks while someone is waiting on the human. */
function useWaitClock(waiting: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [waiting]);
  return now;
}

export function NotchApp({
  search = window.location.search,
}: {
  search?: string;
}) {
  const queryClient = useQueryClient();
  const [geometry] = useState(() => readGeometry(search));
  // ?peek=<seconds> makes peeks frequent (demos, screenshots).
  const peekEveryMs = useMemo(
    () =>
      Math.max(0, Number(new URLSearchParams(search).get("peek")) || 0) * 1000,
    [search],
  );
  const inApp = isInMacApp();

  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [answering, setAnswering] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(soundEnabled);

  const query = useQuery({
    queryKey: NOTCH_QUERY_KEY,
    queryFn: getNotchState,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });
  const state = query.data ?? null;
  const attention = useMemo(() => state?.attention ?? [], [state]);
  const agents = useMemo(() => state?.agents ?? [], [state]);
  const selected = attention.find((a) => a.id === selectedId) ?? attention[0];

  useEffect(() => {
    const uninstall = installNativeReceiver(setExpanded, {
      focusKeyboard: () => setExpanded(true),
      voice: deliverNativeVoice,
    });
    postNative({ type: "ready" });
    return uninstall;
  }, []);
  useGestureUnlock();

  // Sounds + the native tap/peek for new things; the boredom clock.
  const firstSeen = useAttentionSignals(state);
  const now = useWaitClock(attention.length > 0);
  const gang = useMemo(() => gangOf(attention, agents), [attention, agents]);
  const bored = boredomOf(attention, now, firstSeen.current);
  const line = useBanter(bored >= 2 && !expanded, attention, agents);
  const peeker = usePeeks(
    agents,
    attention,
    expanded || line !== null,
    peekEveryMs,
  );

  const arrival = useArrival(state, expanded);
  // Each answer that lands gets a clap from the lead in the open notch.
  const [cheer, setCheer] = useState(0);

  // Room below the notch for the current act.
  const stage = stageHeight({ line, peeker, arrival, expanded });
  useEffect(() => {
    postNative({ type: "stage", height: stage });
  }, [stage]);

  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: NOTCH_QUERY_KEY }),
    [queryClient],
  );

  const answer = useMutation({
    mutationFn: ({ id, choiceId }: { id: string; choiceId: string }) =>
      answerRequest(id, choiceId),
    onMutate: ({ id }) => {
      setError(null);
      setAnswering((s) => new Set(s).add(id));
    },
    // The lead claps for it in the open notch (NotchHero), with the sound.
    onSuccess: () => setCheer((n) => n + 1),
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
    mutationFn: ({ target, text }: { target: ReplyTarget; text: string }) =>
      target.kind === "answer"
        ? answerWithText(target.requestId, text)
        : sendMessage(target.channel, text),
    onMutate: () => setError(null),
    onSuccess: (_d, { target }) => {
      if (target.kind === "answer") setCheer((n) => n + 1);
      else play("sent");
      setComposer(null);
      refresh();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Could not send that"),
  });

  const setVoice = useVoice(setComposer, setError);
  const openComposer = useCallback(
    (target: ReplyTarget) =>
      setComposer({ target, text: "", listening: false }),
    [],
  );
  const cancelComposer = useCallback(() => {
    setVoice(false);
    setComposer(null);
  }, [setVoice]);

  const leadTarget = useCallback((): ReplyTarget | null => {
    if (!state?.lead_dm) return null;
    return {
      kind: "message",
      slug: state.lead ?? "cos",
      name: state.lead_name || "Chief of Staff",
      channel: state.lead_dm,
    };
  }, [state]);
  const replyTarget = useCallback((): ReplyTarget | null => {
    if (!selected) return leadTarget();
    const who = agents.find((a) => a.slug === selected.from);
    return {
      kind: "answer",
      requestId: selected.id,
      to: who?.name ?? selected.from,
    };
  }, [selected, agents, leadTarget]);

  // Out to the full app, at whatever is selected. On the Mac, closing that
  // window hides it again (HideWindowOnClose) and the notch is all that is
  // left, so this is a round trip, not a hand-off.
  const openFull = useCallback(() => {
    postNative({
      type: "open",
      path: selected?.channel
        ? `/channels/${encodeURIComponent(selected.channel)}`
        : "/",
    });
  }, [selected]);

  useNotchKeys(expanded, {
    attention,
    selected,
    composer,
    select: setSelectedId,
    choose: (id, choiceId) => answer.mutate({ id, choiceId }),
    reply: replyTarget,
    lead: leadTarget,
    open: openComposer,
    voice: setVoice,
    openFull,
    close: () => {
      if (composer) cancelComposer();
      else if (inApp) postNative({ type: "collapse" });
      else setExpanded(false);
    },
  });

  // Outside the Mac app (a browser tab, a demo) hovering the notch opens it.
  const hoverProps = inApp
    ? {}
    : {
        onMouseEnter: () => setExpanded(true),
        onMouseLeave: () => {
          if (!composer) setExpanded(false);
        },
      };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundEnabled(next);
    setSoundOn(next);
    postNative({ type: "sound", on: next });
    if (next) play("sent");
  };

  return (
    <div {...hoverProps} className="notch-host">
      <NotchView
        state={state}
        geometry={geometry}
        expanded={expanded}
        gang={gang}
        boredom={bored}
        line={line}
        peeker={peeker}
        arrival={arrival}
        cheer={cheer}
        selectedId={selected?.id ?? null}
        answering={answering}
        composer={composer}
        sending={send.isPending}
        error={error ?? (query.isError ? "Lost the office. Retrying…" : null)}
        soundOn={soundOn}
        voiceAvailable={voiceAvailable()}
        onSelect={setSelectedId}
        onAnswer={(id, choiceId) => answer.mutate({ id, choiceId })}
        onReply={openComposer}
        onComposerText={(text) => setComposer((c) => (c ? { ...c, text } : c))}
        onComposerSubmit={() =>
          composer &&
          send.mutate({ target: composer.target, text: composer.text.trim() })
        }
        onComposerCancel={cancelComposer}
        onVoice={setVoice}
        onOpen={(path) => postNative({ type: "open", path })}
        onKeyboard={(active) => postNative({ type: "keyboard", active })}
        onToggleSound={toggleSound}
        onOpenFull={openFull}
      />
    </div>
  );
}
