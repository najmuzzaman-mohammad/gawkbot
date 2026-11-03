import { useState } from "react";

import type { NotchScreen } from "../screens";
import type { NotchState } from "../types";
import { chatScreen, hasSuggestions, sidebarBots } from "./model";
import { AgentRow, SessionsRow, SuggestionsRow } from "./NotchRows";

export interface NotchSidebarProps {
  state: NotchState;
  /** What the right pane shows now (resolved: never "home"). */
  current: NotchScreen;
  now: number;
  onPick: (screen: NotchScreen) => void;
  onNewBot: () => void;
  onSettings: () => void;
  onOpenFull: () => void;
}

/**
 * The open notch's left column: search, a new bot, the suggestions group,
 * every office bot, the sessions group, and settings at the foot.
 */
export function NotchSidebar(props: NotchSidebarProps) {
  const { state, current, now } = props;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const bots = sidebarBots(state).filter(
    (a) => !q || a.name.toLowerCase().includes(q),
  );
  const pickAgent = (slug: string) => {
    const agent = state.agents.find((a) => a.slug === slug);
    const chat = agent ? chatScreen(agent, state) : null;
    if (chat) props.onPick(chat);
  };
  return (
    <nav className="nside" aria-label="Bots">
      <div className="nside-head">
        <label className="nside-search">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            aria-label="Search bots"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="nicon"
          aria-label="New bot"
          title="New bot"
          onClick={props.onNewBot}
        >
          +
        </button>
      </div>
      <ul className="nside-list">
        {!q && hasSuggestions(state) && state.ideas ? (
          <SuggestionsRow
            ideas={state.ideas}
            now={now}
            selected={current.kind === "suggestions"}
            onClick={() => props.onPick({ kind: "suggestions" })}
          />
        ) : null}
        {bots.map((agent) => (
          <AgentRow
            key={agent.slug}
            agent={agent}
            state={state}
            now={now}
            selected={current.kind === "agent" && current.slug === agent.slug}
            onClick={() => pickAgent(agent.slug)}
          />
        ))}
        {!q ? (
          <SessionsRow
            state={state}
            now={now}
            selected={current.kind === "sessions"}
            onClick={() => props.onPick({ kind: "sessions" })}
          />
        ) : null}
      </ul>
      <div className="nside-foot">
        <button
          type="button"
          className="nbtn is-quiet"
          title="Open the full app (O)"
          onClick={props.onOpenFull}
        >
          Full view ↗
        </button>
        <button
          type="button"
          className={`nicon${current.kind === "settings" ? " is-on" : ""}`}
          aria-label="Settings"
          title="Settings (,)"
          onClick={props.onSettings}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 6.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Zm7 4.3v-2.2l-2-.5a5.6 5.6 0 0 0-.6-1.4l1.1-1.8-1.6-1.6-1.8 1.1c-.4-.3-.9-.5-1.4-.6L10.2 2H8l-.5 2a5.6 5.6 0 0 0-1.4.6L4.3 3.5 2.7 5.1l1.1 1.8c-.3.4-.5.9-.6 1.4l-2 .5v2.2l2 .5c.1.5.3 1 .6 1.4l-1.1 1.8 1.6 1.6 1.8-1.1c.4.3.9.5 1.4.6l.5 2h2.2l.5-2c.5-.1 1-.3 1.4-.6l1.8 1.1 1.6-1.6-1.1-1.8c.3-.4.5-.9.6-1.4Z" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
