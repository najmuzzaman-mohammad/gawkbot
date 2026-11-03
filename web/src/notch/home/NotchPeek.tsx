import { useLayoutEffect, useRef } from "react";

import type { NotchScreen } from "../screens";
import type { NotchState } from "../types";
import { chatScreen, sidebarBots } from "./model";
import { AgentRow, SessionsRow, SuggestionsRow } from "./NotchRows";

/** The most bots the hover list shows; the rest are a click away in Home. */
export const PEEK_BOTS = 6;
/** The hover list's width; the Mac app sizes the panel to it. */
export const PEEK_WIDTH = 340;

export interface NotchPeekProps {
  state: NotchState;
  now: number;
  /** Opens Home on a row's pane. */
  onPick: (screen: NotchScreen) => void;
  /** Opens Home as it last was. */
  onExpand: () => void;
  /** The list's height, each time it changes, for the panel to fit. */
  onHeight: (height: number) => void;
}

/**
 * What hovering the notch shows: a short list that drops out of it. The
 * suggestions when ideas wait, the bots most worth a look, the sessions
 * group, and a way into Home. Nothing here acts on its own.
 */
export function NotchPeek({
  state,
  now,
  onPick,
  onExpand,
  onHeight,
}: NotchPeekProps) {
  const ref = useRef<HTMLDivElement>(null);
  const bots = sidebarBots(state).slice(0, PEEK_BOTS);
  const { ideas } = state;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) onHeight(Math.ceil(el.getBoundingClientRect().height));
  });
  return (
    <div className="npeek" ref={ref} data-testid="notch-peek">
      <ul className="nside-list">
        {ideas && ideas.items.length > 0 ? (
          <SuggestionsRow
            ideas={ideas}
            now={now}
            onClick={() => onPick({ kind: "suggestions" })}
          />
        ) : null}
        {bots.map((agent) => (
          <AgentRow
            key={agent.slug}
            agent={agent}
            state={state}
            now={now}
            onClick={() => {
              const chat = chatScreen(agent, state);
              if (chat) onPick(chat);
            }}
          />
        ))}
        <SessionsRow
          state={state}
          now={now}
          onClick={() => onPick({ kind: "sessions" })}
        />
      </ul>
      <div className="npeek-foot">
        <span className="npeek-headline">{state.headline}</span>
        <button
          type="button"
          className="nicon"
          aria-label="Open the notch"
          title="Open (⌥Space)"
          onClick={onExpand}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
          </svg>
        </button>
      </div>
    </div>
  );
}
