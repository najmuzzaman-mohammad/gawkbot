import { useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { BotRuntimeContext } from "../lib/botRuntime";
import { getNotchState, stopBot } from "./api";
import { cardKey, type DockCard, dockCards, trackDone } from "./dock";
import { postDock } from "./dockBridge";
import { NotchBot } from "./NotchBot";

export const DOCK_QUERY_KEY = ["notch-state", "dock"] as const;
const POLL_MS = 2_000;

const STATE_WORDS = {
  working: "Working",
  needs_you: "Needs you",
  done: "Done",
} as const;

export interface NotchDockCardsProps {
  cards: DockCard[];
  done: ReadonlyMap<string, number>;
  /** Slugs whose stop was asked for and has not shown yet. */
  stopping: ReadonlySet<string>;
  /** Opens the notch on this bot's chat. */
  onChat: (slug: string) => void;
  onStop: (slug: string) => void;
  onClose: (key: string) => void;
}

function Card({
  card,
  closeKey,
  halting,
  onChat,
  onStop,
  onClose,
}: {
  card: DockCard;
  closeKey: string;
  halting: boolean;
} & Pick<NotchDockCardsProps, "onChat" | "onStop" | "onClose">) {
  const [open, setOpen] = useState(false);
  const { agent, kind } = card;
  return (
    <li
      className={`ndock-card is-${kind}`}
      data-testid={`notch-dock-${agent.slug}`}
    >
      <div className="ndock-head">
        <NotchBot
          slug={agent.slug}
          avatar={agent.avatar}
          mood={kind === "done" ? "done" : agent.mood}
          size={26}
          label=""
        />
        <span className="ndock-who">
          <span className="ndock-name">{agent.name}</span>
          <span className="ndock-state">
            <i aria-hidden="true" />
            {halting ? "Stopping" : STATE_WORDS[kind]}
          </span>
        </span>
        {kind !== "working" ? (
          <button
            type="button"
            className="ndock-x"
            aria-label={`Close ${agent.name}'s card`}
            onClick={() => onClose(closeKey)}
          >
            ×
          </button>
        ) : null}
      </div>
      <p className={`ndock-line${open ? " is-open" : ""}`}>{card.line}</p>
      {open && card.history.length > 0 ? (
        <ul className="ndock-history">
          {card.history.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      ) : null}
      <div className="ndock-actions">
        <button
          type="button"
          className="ndock-more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> History
        </button>
        {kind === "working" ? (
          <button
            type="button"
            className="nbtn is-quiet"
            disabled={halting}
            aria-label={`Stop ${agent.name}`}
            onClick={() => onStop(agent.slug)}
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="nbtn is-primary"
          onClick={() => onChat(agent.slug)}
        >
          {kind === "needs_you" ? "Answer" : "Open"}
        </button>
      </div>
    </li>
  );
}

/** The cards themselves, with nothing to fetch: what the story shows. */
export function NotchDockCards(props: NotchDockCardsProps) {
  if (props.cards.length === 0) return null;
  return (
    <ul className="ndock" aria-label="Bots">
      {props.cards.map((card) => (
        <Card
          key={`${card.kind}:${card.agent.slug}`}
          card={card}
          closeKey={cardKey(card, props.done)}
          halting={props.stopping.has(card.agent.slug)}
          onChat={props.onChat}
          onStop={props.onStop}
          onClose={props.onClose}
        />
      ))}
    </ul>
  );
}

/**
 * The dock page: polls the same office state as the notch, keeps who just
 * finished and which cards were closed, tells the Mac app how much room
 * the cards need, and hands it the bot to open the notch on.
 */
export function NotchDock() {
  const query = useQuery({
    queryKey: DOCK_QUERY_KEY,
    queryFn: () => getNotchState(false),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });
  const state = query.data;
  const [done, setDone] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const toldRef = useRef({ height: -1, count: -1 });

  // Who finished since the last poll. The first poll only remembers, so
  // opening the app does not shower it with old finishes.
  const nowWorking = new Set(
    (state?.agents ?? [])
      .filter((a) => a.mood === "working")
      .map((a) => a.slug),
  );
  const workKey = state ? [...nowWorking].sort().join(",") : null;
  const [seenWork, setSeenWork] = useState<string | null>(null);
  if (state && workKey !== seenWork) {
    if (seenWork !== null) {
      const before = new Set(seenWork ? seenWork.split(",") : []);
      setDone(trackDone(before, state, done, Date.now()));
    }
    setSeenWork(workKey);
  }

  // A stop that took effect is a bot no longer at work: forget it.
  const stale = [...stopping].filter((slug) => !nowWorking.has(slug));
  if (stale.length > 0) {
    const next = new Set(stopping);
    for (const slug of stale) next.delete(slug);
    setStopping(next);
  }

  const cards = dockCards(state, done, closed, Date.now());
  useLayoutEffect(() => {
    const count = cards.length;
    const height = count > 0 ? (rootRef.current?.offsetHeight ?? 0) : 0;
    if (toldRef.current.height === height && toldRef.current.count === count)
      return;
    toldRef.current = { height, count };
    postDock({ type: "dock", height, count });
  });

  const runtimeOf = (slug: string) =>
    state?.agents.find((a) => a.slug === slug)?.runtime;

  return (
    <BotRuntimeContext.Provider value={runtimeOf}>
      <div ref={rootRef} className="ndock-root" data-testid="notch-dock">
        <NotchDockCards
          cards={cards}
          done={done}
          stopping={stopping}
          onChat={(slug) => postDock({ type: "chat", slug })}
          onClose={(key) => setClosed((c) => new Set(c).add(key))}
          onStop={(slug) => {
            setStopping((prev) => new Set(prev).add(slug));
            void stopBot(slug).catch(() => {
              setStopping((prev) => {
                const next = new Set(prev);
                next.delete(slug);
                return next;
              });
            });
          }}
        />
      </div>
    </BotRuntimeContext.Provider>
  );
}
