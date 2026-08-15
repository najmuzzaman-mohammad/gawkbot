// AgentSessions — the agent's chats, plural. Every routine runs in its own
// session; the operator can browse them all and start new manual ones (Claude
// Routines-style). A session strip sits atop the Ask Agent dock; each session's
// transcript stays mounted (hidden, not unmounted) so switching never loses
// state. With a REAL agent id (app_…) sessions and their transcripts load from
// the agent service, "New chat" persists a session, and the manual chat mirrors
// each turn to the service fire-and-forget; when the service is unreachable the
// dock falls back to the seeded state. See docs/specs/operator-agent-routines.md.

import { useEffect, useRef, useState } from "react";
import { CalendarClock, MessageSquareText, Plus } from "lucide-react";

import { isRealAppId } from "../apps/useOperatorApps";
import { type ChatSessionMeta, newSession } from "../routines/routines";
import { AppToolsChat } from "../surfaces/AppToolsChat";
import {
  tryCreateSession,
  tryGetSession,
  tryListSessions,
  trySendSessionMessage,
  type WireSession,
  type WireSessionMessage,
} from "./agentStateClient";

interface AgentSessionsProps {
  agentName: string;
  /** Real agent id (app_…). When set, sessions persist via the agent service;
   * without it (mock agents) the dock keeps its local seeded state. */
  agentId?: string;
  /** Open this session (e.g. from a routine's "Open its chat"). */
  requestedSessionId?: string | null;
  /** One-shot instruction for the manual session (demo hand-off). */
  seed?: string;
}

type Transcript = { from: "you" | "nex"; body: string }[];

// Honest fallback when a routine session's persisted transcript could not be
// fetched: say so — never fabricate a "Ran the routine…" outcome (2026-08-15
// audit).
function routineTranscript(title: string): Transcript {
  return [
    { from: "you", body: `(scheduled) ${title}` },
    {
      from: "nex",
      body: "This run's transcript could not be loaded right now. Reopen it in a moment.",
    },
  ];
}

function toMeta(s: WireSession): ChatSessionMeta {
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    at: s.at,
    routine: s.routine,
  };
}

function toTranscript(messages: WireSessionMessage[]): Transcript {
  return messages.map(({ from, body }) => ({ from, body }));
}

export function AgentSessions({
  agentName,
  agentId,
  requestedSessionId,
  seed,
}: AgentSessionsProps) {
  // Real agents START EMPTY: one local draft chat, no fabricated history
  // (2026-08-15 audit: seeded "Monday pipeline recap · Monday 9:02" chips
  // rendered as real history, forever when the service was unreachable).
  const [sessions, setSessions] = useState<ChatSessionMeta[]>(() => [
    newSession("Chat with your agent", "manual"),
  ]);
  // The service could not be reached — the strip says so instead of faking.
  const [unavailable, setUnavailable] = useState(false);
  const [activeId, setActiveId] = useState<string>(sessions[0]?.id ?? "");
  // Mount a session's pane on first visit, then keep it alive.
  const [mounted, setMounted] = useState<string[]>([activeId]);
  // True once the agent service answered — from then on writes go to it.
  const [live, setLive] = useState(false);
  // Persisted transcripts by session id; null = fetched but unavailable.
  const [transcripts, setTranscripts] = useState<
    Record<string, Transcript | null>
  >({});

  const realId = isRealAppId(agentId) ? agentId : undefined;
  // The session the operator explicitly opened (strip click or a routine's
  // "Open its chat"). The list hydration below resolves LATER and must not
  // clobber it back to the first session.
  const pickedRef = useRef<string | null>(null);
  // The synthesized default manual chat used when the service has ONLY routine
  // sessions: it never opens a routine's run transcript by default (manual
  // chatting would pollute the run history). It stays LOCAL and is created on
  // the service only when the operator first sends a message. draftServiceRef
  // memoizes that one-time create so both turns of the first exchange land in
  // the same real session.
  const draftManualIdRef = useRef<string | null>(null);
  if (draftManualIdRef.current === null && sessions[0]?.kind === "manual") {
    // The initial local chat IS a draft — it persists to the service only on
    // the first sent message.
    draftManualIdRef.current = sessions[0].id;
  }
  const draftServiceRef = useRef<Map<string, Promise<string | null>>>(
    new Map(),
  );

  useEffect(() => {
    if (!realId) return;
    let cancelled = false;
    void tryListSessions(realId).then(async (remote) => {
      if (cancelled) return;
      if (!remote) {
        // Unreachable — keep the local draft chat usable and say why.
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      const picked = pickedRef.current;
      // Default to a MANUAL session, never a routine's run transcript — manual
      // chatting/teaching in a routine session would pollute its run history.
      // An explicitly requested session (a routine's "Open its chat") wins.
      const target =
        (picked && remote.find((s) => s.id === picked)) ||
        remote.find((s) => s.kind === "manual") ||
        null;
      // Fetch the target session's transcript BEFORE mounting its pane: a pane
      // reads its initialTranscript only at mount.
      const detail = target ? await tryGetSession(target.id, realId) : null;
      if (cancelled) return;
      setLive(true);
      if (target) {
        setSessions(remote.map(toMeta));
        setTranscripts({
          [target.id]: detail ? toTranscript(detail.messages) : null,
        });
        setActiveId(target.id);
        setMounted([target.id]);
      } else {
        // Only routine sessions exist (or none): present a fresh local manual
        // chat as the default so the operator lands in a clean chat instead of
        // a routine's run transcript. It persists to the service only on the
        // first sent message (see turnHandlerFor).
        const draft = newSession("Chat with your agent", "manual");
        draftManualIdRef.current = draft.id;
        setSessions([draft, ...remote.map(toMeta)]);
        setTranscripts({ [draft.id]: [] });
        setActiveId(draft.id);
        setMounted([draft.id]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [realId]);

  function open(id: string) {
    pickedRef.current = id;
    setActiveId(id);
    if (mounted.includes(id)) return;
    if (live && realId && !(id in transcripts)) {
      // Load the persisted transcript first, then mount the pane on it.
      void tryGetSession(id, realId).then((detail) => {
        setTranscripts((prev) => ({
          ...prev,
          [id]: detail ? toTranscript(detail.messages) : null,
        }));
        setMounted((prev) => (prev.includes(id) ? prev : [...prev, id]));
      });
      return;
    }
    setMounted((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  // Read through a ref so the resolve-on-request effect keys ONLY on the
  // request: re-running it on every sessions refresh would re-open a session
  // the operator has already navigated away from.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    if (!requestedSessionId) return;
    // A live routine's "Open its chat" hands over its scheduler SLUG — the
    // session that routine's runs land in is matched by meta.routine. A
    // session id (seeded mocks, strip clicks) passes through unchanged.
    const byRoutine = sessionsRef.current.find(
      (s) => s.routine === requestedSessionId,
    );
    open(byRoutine ? byRoutine.id : requestedSessionId);
  }, [requestedSessionId]);

  function addManual() {
    const title = `Chat ${sessions.length + 1}`;
    const openNew = (s: ChatSessionMeta) => {
      setSessions((prev) => [...prev, s]);
      setTranscripts((prev) => ({ ...prev, [s.id]: [] }));
      setActiveId(s.id);
      setMounted((prev) => (prev.includes(s.id) ? prev : [...prev, s.id]));
    };
    if (live && realId) {
      void tryCreateSession(realId, title).then((created) => {
        openNew(created ? toMeta(created) : newSession(title, "manual"));
      });
      return;
    }
    openNew(newSession(title, "manual"));
  }

  // Where a chat turn's live mirror goes. A normal session mirrors each turn to
  // the service fire-and-forget. The synthesized default manual chat is LOCAL
  // until its first turn: it then creates the real session once and mirrors this
  // and every later turn to it, so an unused default never litters the service.
  function turnHandlerFor(
    s: ChatSessionMeta,
  ): ((from: "you" | "nex", body: string) => void) | undefined {
    if (!(live && realId)) return undefined;
    const agent = realId;
    if (s.id !== draftManualIdRef.current) {
      return (from, body) => trySendSessionMessage(s.id, { agent, from, body });
    }
    return (from, body) => {
      let created = draftServiceRef.current.get(s.id);
      if (!created) {
        created = tryCreateSession(agent, s.title).then((c) =>
          c ? c.id : null,
        );
        draftServiceRef.current.set(s.id, created);
      }
      void created.then((sid) => {
        if (sid) trySendSessionMessage(sid, { agent, from, body });
      });
    };
  }

  // What a pane starts from: the persisted transcript when the service has
  // one, the mock routine transcript for offline routine sessions, else the
  // chat's own greeting.
  function initialTranscriptFor(s: ChatSessionMeta): Transcript | undefined {
    const fetched = transcripts[s.id];
    if (fetched && fetched.length > 0) return fetched;
    if (s.kind === "routine") return routineTranscript(s.title);
    return undefined;
  }

  return (
    <div className="opr-agent-sessions">
      <div className="opr-session-strip" aria-label="Chat sessions">
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`opr-session-chip${s.id === activeId ? " is-active" : ""}`}
            onClick={() => open(s.id)}
            title={`${s.title} · ${s.at}`}
          >
            {s.kind === "routine" ? (
              <CalendarClock size={11} strokeWidth={2} aria-hidden={true} />
            ) : (
              <MessageSquareText size={11} strokeWidth={2} aria-hidden={true} />
            )}
            <span className="opr-session-chip-title">{s.title}</span>
          </button>
        ))}
        <button
          type="button"
          className="opr-session-chip opr-session-new"
          onClick={addManual}
          aria-label="New chat"
        >
          <Plus size={11} strokeWidth={2} aria-hidden={true} />
          New chat
        </button>
      </div>
      {unavailable ? (
        <p className="opr-scoped-note">
          Past sessions are unavailable right now — the agent service could not
          be reached. You can still chat here; it will sync once the workspace
          reconnects.
        </p>
      ) : null}

      <div className="opr-session-panes">
        {sessions
          .filter((s) => mounted.includes(s.id))
          .map((s) => (
            <div
              key={s.id}
              style={s.id === activeId ? undefined : { display: "none" }}
            >
              <AppToolsChat
                appName={agentName}
                seed={
                  s.kind === "manual" && s.id === sessions[0]?.id
                    ? seed
                    : undefined
                }
                initialTranscript={initialTranscriptFor(s)}
                onTurn={turnHandlerFor(s)}
              />
            </div>
          ))}
      </div>
    </div>
  );
}
