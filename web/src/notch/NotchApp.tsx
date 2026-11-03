import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { hush } from "./announce";
import { boredom as boredomOf, gang as gangOf } from "./antics";
import {
  answerRequest,
  answerWithText,
  getNotchState,
  markFinishedSeen,
  NOTCH_QUERY_KEY,
  requestPermission,
  sendMessage,
  showSession,
  stopBot,
} from "./api";
import {
  installNativeReceiver,
  isInMacApp,
  postNative,
  readGeometry,
} from "./bridge";
import { chatScreen, resolveHome } from "./home/model";
import { newBotRequest } from "./home/NewBotPane";
import { useAttentionSignals, useNotchKeys, useVoice } from "./hooks";
import { nudgeForIdeas } from "./ideasNudge";
import { pollInterval, useNotchLive } from "./live";
import { stripShapeFor } from "./NotchStrip";
import { type NotchMode, NotchView } from "./NotchView";
import { finishedSlugs } from "./order";
import { drawOnScreen, relayOverlay } from "./overlay";
import { useRealtime } from "./realtime/useRealtime";
import {
  HOME,
  NEW_BOT,
  type NotchScreen,
  SETTINGS,
  screenForTarget,
} from "./screens";
import type { ComposerState, ReplyTarget } from "./shared";
import { play, unlock } from "./sounds";
import type { NotchState } from "./types";
import { useAnnounce } from "./useAnnounce";
import { deliverNativeVoice, voiceAvailable } from "./voice";

export { moodTransitions, newAttentionIds } from "./hooks";

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

/** A clock for the rows' times, ticking each 30 s while the notch is open. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [running]);
  return now;
}

export function NotchApp({
  search = window.location.search,
}: {
  search?: string;
}) {
  const queryClient = useQueryClient();
  const [measured] = useState(() => readGeometry(search));
  // The open panel's size, when the app has one to tell (dragged, remembered).
  const [openSize, setOpenSize] = useState<{ w: number; h: number } | null>(
    null,
  );
  const inApp = isInMacApp();

  const [expanded, setExpanded] = useState(false);
  // Hovering shows the short list; the hotkey, or a row in it, opens Home.
  const [mode, setMode] = useState<NotchMode>("peek");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  // Home (resolved from what is going on), or a pane the sidebar picked.
  const [screen, setScreen] = useState<NotchScreen>(HOME);
  useEffect(() => {
    if (!expanded) {
      setScreen(HOME);
      setComposer(null);
    }
  }, [expanded]);
  const [answering, setAnswering] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // The poll tells the broker when the panel is open, through a ref so the
  // query key (and its data) stays put across open and close.
  const openRef = useRef(expanded);
  openRef.current = expanded;
  // Changes arrive from the event stream the moment they happen; the poll
  // is the open notch's heartbeat (it lets the office read the screen)
  // and the fallback when the stream is not there (live.ts).
  const live = useNotchLive(queryClient);
  const query = useQuery({
    queryKey: NOTCH_QUERY_KEY,
    queryFn: () => getNotchState(openRef.current),
    refetchInterval: pollInterval(expanded, live),
    refetchIntervalInBackground: true,
  });
  const state = query.data ?? null;
  // Drawings the office left for the screen go to the app once each.
  const drawnSeq = useRef(0);
  useEffect(() => {
    drawnSeq.current = relayOverlay(
      drawnSeq.current,
      state?.overlay,
      drawOnScreen,
    );
  }, [state?.overlay]);
  const attention = useMemo(() => state?.attention ?? [], [state]);
  const agents = useMemo(() => state?.agents ?? [], [state]);
  const selected = attention.find((a) => a.id === selectedId) ?? attention[0];
  const resolved =
    state && screen.kind === "home" ? resolveHome(state) : screen;

  // Home on a pane: in the Mac app the panel grows to Home's size first.
  const openHome = useCallback(
    (next: NotchScreen) => {
      setScreen(next);
      setMode("home");
      setExpanded(true);
      if (inApp) postNative({ type: "home" });
    },
    [inApp],
  );

  useEffect(() => {
    const uninstall = installNativeReceiver(setExpanded, {
      setSize: (w, h) => {
        if (w > 0 && h > 0) setOpenSize({ w, h });
      },
      setMode: (m) => setMode(m === "home" ? "home" : "peek"),
      focusKeyboard: () => {
        setMode("home");
        setExpanded(true);
      },
      showAgent: (slug) => {
        const s = queryClient.getQueryData<NotchState>(NOTCH_QUERY_KEY);
        const agent = s?.agents.find((a) => a.slug === slug);
        const chat = agent && s ? chatScreen(agent, s) : null;
        setScreen(chat ?? HOME);
        setMode("home");
        setExpanded(true);
      },
      voice: deliverNativeVoice,
    });
    postNative({ type: "ready" });
    return uninstall;
  }, [queryClient]);
  useGestureUnlock();

  // Sounds for new things. Nothing drops out of the notch: the cards at the
  // top right (NotchDock) carry what a bot has to say.
  useAttentionSignals(state);
  const gang = useMemo(() => gangOf(attention, agents), [attention, agents]);
  const now = useClock(expanded);
  const bored = boredomOf(attention, now, new Map());

  // On a Mac with a notch the strip is exactly the notch while nothing is
  // going on, and every state is a small coloured dot in a centred row just
  // under it: red for an answer needed, green for a finished turn, orange
  // for work.
  const finished = useMemo(() => finishedSlugs(state), [state]);
  const shape = stripShapeFor(measured, finished, agents);
  const geometry = useMemo(
    () => ({
      ...measured,
      earWidth: shape.earWidth,
      band: shape.band,
      ...(openSize
        ? { expandedWidth: openSize.w, expandedHeight: openSize.h }
        : {}),
    }),
    [measured, shape.earWidth, shape.band, openSize],
  );
  useEffect(() => {
    postNative({ type: "ears", width: shape.earWidth, band: shape.band });
  }, [shape.earWidth, shape.band]);
  const onPeekHeight = useCallback(
    (height: number) => {
      postNative({ type: "peek", height: height + measured.notchHeight });
    },
    [measured.notchHeight],
  );

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
    onSuccess: () => play("sent"),
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

  // Out to where a terminal session really runs. The notch steps aside so
  // the window it brings forward is not under it.
  const showSource = useMutation({
    mutationFn: (slug: string) => showSession(slug),
    onMutate: () => setError(null),
    onSuccess: () => {
      if (inApp) postNative({ type: "collapse" });
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Could not open it"),
  });

  const screenRef = useRef(screen);
  screenRef.current = screen;
  const send = useMutation({
    mutationFn: ({ target, text }: { target: ReplyTarget; text: string }) =>
      target.kind === "answer"
        ? answerWithText(target.requestId, text)
        : sendMessage(target.channel, text),
    onMutate: () => setError(null),
    onSuccess: (_d, { target }) => {
      play("sent");
      if (target.kind === "message") {
        // A finished turn replied to is done with: its dot goes.
        for (const f of state?.finished ?? []) {
          if (f.from === target.slug)
            void markFinishedSeen(f.id).catch(() => undefined);
        }
      }
      // In a chat the box stays, empty, for the next line.
      setComposer((c) =>
        c && target.kind === "message" ? { ...c, text: "" } : null,
      );
      refresh();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Could not send that"),
  });

  const setVoiceSession = useVoice(setComposer, setError);
  const [talking, setTalking] = useState(false);
  // The talk key: while it is down the notch listens and says nothing.
  const setVoice = useCallback(
    (on: boolean) => {
      setTalking(on);
      if (on) hush();
      setVoiceSession(on);
    },
    [setVoiceSession],
  );
  useAnnounce(state, talking);
  // The morning's ideas: one line, per look, with the notch closed.
  const ideasCheckedAt = state?.ideas?.checked_at ?? "";
  const nudgeLatest = useRef({ state, expanded, talking });
  nudgeLatest.current = { state, expanded, talking };
  useEffect(() => {
    if (!ideasCheckedAt) return;
    const at = nudgeLatest.current;
    if (!at.talking) nudgeForIdeas(at.state, at.expanded);
  }, [ideasCheckedAt, expanded]);
  // Talking to the office out loud, when the office has a key for it.
  const talk = useRealtime(
    expanded,
    state?.capabilities?.screen_capture === true,
  );
  const talkRef = useRef(talk);
  talkRef.current = talk;
  const talkKey = useCallback((on: boolean): boolean => {
    const t = talkRef.current;
    if (on) {
      if (!t.available) return false;
      setTalking(true);
      hush();
      t.hold();
      return true;
    }
    setTalking(false);
    t.release();
    return true;
  }, []);
  // A message to a bot opens its chat with the box ready; an answer to a
  // question opens the box under it, in the asking bot's chat.
  const openComposer = useCallback(
    (target: ReplyTarget) => {
      setComposer({ target, text: "", listening: false });
      const next = screenForTarget(target);
      if (next) openHome(next);
    },
    [openHome],
  );
  const goHome = useCallback(() => {
    setVoice(false);
    setComposer(null);
    setScreen(HOME);
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
    if (resolved.kind === "agent") {
      const asked = attention.find((a) => a.from === resolved.slug);
      if (asked) {
        return { kind: "answer", requestId: asked.id, to: resolved.name };
      }
      return {
        kind: "message",
        slug: resolved.slug,
        name: resolved.name,
        channel: resolved.channel,
      };
    }
    if (!selected) return leadTarget();
    const who = agents.find((a) => a.slug === selected.from);
    return {
      kind: "answer",
      requestId: selected.id,
      to: who?.name ?? selected.from,
    };
  }, [resolved, attention, selected, agents, leadTarget]);

  // Out to the full app, at whatever is open. On the Mac, closing that
  // window hides it again (HideWindowOnClose) and the notch is all that is
  // left, so this is a round trip, not a hand-off.
  const openFull = useCallback(() => {
    postNative({
      type: "open",
      path:
        resolved.kind === "agent"
          ? `/channels/${encodeURIComponent(resolved.channel)}`
          : "/",
    });
  }, [resolved]);

  // Picking a question (keys J/K) shows it in its bot's chat.
  const selectCard = useCallback(
    (id: string) => {
      setSelectedId(id);
      const card = attention.find((a) => a.id === id);
      const agent = card && agents.find((a) => a.slug === card.from);
      const chat = agent && state ? chatScreen(agent, state) : null;
      if (chat) setScreen(chat);
    },
    [attention, agents, state],
  );

  useNotchKeys(expanded && mode === "home", {
    attention,
    selected,
    composer,
    select: selectCard,
    choose: (id, choiceId) => answer.mutate({ id, choiceId }),
    suggest: (id, text) => {
      const asked = attention.find((a) => a.id === id);
      if (asked) {
        send.mutate({
          target: {
            kind: "answer",
            requestId: id,
            to: asked.from_name ?? asked.from,
          },
          text,
        });
      }
    },
    done: () => undefined,
    reply: replyTarget,
    lead: leadTarget,
    open: openComposer,
    voice: setVoice,
    talk: talkKey,
    settings: () => setScreen(SETTINGS),
    openFull,
    close: () => {
      if (talk.phase !== "idle" || talk.said) talk.end();
      else if (composer) {
        setVoice(false);
        setComposer(null);
      } else if (screen.kind !== "home") goHome();
      else if (inApp) postNative({ type: "collapse" });
      else setExpanded(false);
    },
  });

  // Outside the Mac app (a browser tab, a demo) hovering the notch opens
  // the short list, and leaving it closes whatever is open.
  const hoverProps = inApp
    ? {}
    : {
        onMouseEnter: () => {
          if (!expanded) {
            setMode("peek");
            setExpanded(true);
          }
        },
        onMouseLeave: () => {
          if (!composer) setExpanded(false);
        },
      };

  const leadChannel = state?.lead_dm ?? null;
  return (
    <div {...hoverProps} className="notch-host">
      <NotchView
        state={state}
        geometry={geometry}
        expanded={expanded}
        mode={mode}
        screen={resolved}
        gang={gang}
        boredom={bored}
        now={now}
        selectedId={selected?.id ?? null}
        answering={answering}
        composer={composer}
        sending={send.isPending}
        error={error ?? (query.isError ? "Lost the office. Retrying…" : null)}
        voiceAvailable={voiceAvailable()}
        voice={talk.available || talk.phase !== "idle" ? talk : undefined}
        talking={talking}
        onPick={openHome}
        onExpand={() => openHome(screen)}
        onPeekHeight={onPeekHeight}
        onBack={goHome}
        onSettings={() => setScreen(SETTINGS)}
        onNewBot={() => setScreen(NEW_BOT)}
        onNewBotSubmit={(what) => {
          const lead = leadTarget();
          if (!lead || lead.kind !== "message" || !leadChannel) return;
          send.mutate({ target: lead, text: newBotRequest(what) });
          setComposer({ target: lead, text: "", listening: false });
          setScreen(screenForTarget(lead) ?? HOME);
        }}
        onOpenFull={openFull}
        onStop={(slug) =>
          void stopBot(slug).catch(() => setError("Could not stop it"))
        }
        onShowSource={(slug) => showSource.mutate(slug)}
        onCompose={openComposer}
        onSelect={selectCard}
        onAnswer={(id, choiceId) => answer.mutate({ id, choiceId })}
        onReply={openComposer}
        onSend={(target, text) => send.mutate({ target, text })}
        onOpen={(path) => postNative({ type: "open", path })}
        onComposerText={(text) => setComposer((c) => (c ? { ...c, text } : c))}
        onComposerSubmit={() =>
          composer &&
          send.mutate({ target: composer.target, text: composer.text.trim() })
        }
        onComposerCancel={() => {
          setVoice(false);
          setComposer(null);
        }}
        onVoice={setVoice}
        onKeyboard={(active) => postNative({ type: "keyboard", active })}
        onPermission={(kind) => void requestPermission(kind)}
      />
    </div>
  );
}
