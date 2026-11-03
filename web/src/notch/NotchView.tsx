import { useCallback, useMemo } from "react";

import { type BotRuntime, BotRuntimeContext } from "../lib/botRuntime";
import type { Boredom } from "./antics";
import { EXPANDED_HEIGHT, EXPANDED_WIDTH } from "./bridge";
import { NewBotPane } from "./home/NewBotPane";
import { NotchPeek, PEEK_WIDTH } from "./home/NotchPeek";
import { NotchSidebar } from "./home/NotchSidebar";
import { SessionsPane } from "./home/SessionsPane";
import { NotchIdeas } from "./NotchIdeas";
import type { QuestionHandlers } from "./NotchQuestion";
import { NotchSettings } from "./NotchSettings";
import { NotchStrip } from "./NotchStrip";
import { NotchThread } from "./NotchThread";
import type { RealtimeTalk } from "./realtime/useRealtime";
import type { NotchScreen } from "./screens";
import type { ComposerState, ReplyTarget } from "./shared";
import type { NotchAgent, NotchGeometry, NotchState } from "./types";

// Presentational notch: the strip (always) and, when open, either the
// hover list (peek) or Home: the sidebar and one pane. NotchApp owns the
// data, timers, sounds and the native bridge.

export { EXPANDED_HEIGHT, EXPANDED_WIDTH } from "./bridge";

/** How the open notch is showing: the hover list, or the whole of Home. */
export type NotchMode = "peek" | "home";

export interface NotchViewProps extends QuestionHandlers {
  state: NotchState | null;
  geometry: NotchGeometry;
  expanded: boolean;
  mode: NotchMode;
  /** The pane Home shows, already resolved (never "home"). */
  screen: NotchScreen;
  gang: NotchAgent[];
  boredom: Boredom;
  now: number;
  selectedId: string | null;
  answering: ReadonlySet<string>;
  composer: ComposerState | null;
  sending: boolean;
  error: string | null;
  voiceAvailable: boolean;
  voice?: Pick<RealtimeTalk, "phase" | "heard" | "said" | "error">;
  talking?: boolean;
  onPick: (screen: NotchScreen) => void;
  onExpand: () => void;
  onPeekHeight: (height: number) => void;
  onBack: () => void;
  onSettings: () => void;
  onNewBot: () => void;
  onNewBotSubmit: (what: string) => void;
  onOpenFull: () => void;
  onStop: (slug: string) => void;
  onShowSource: (slug: string) => void;
  onCompose: (target: ReplyTarget) => void;
  onComposerText: (text: string) => void;
  onComposerSubmit: () => void;
  onComposerCancel: () => void;
  onVoice: (on: boolean) => void;
  onKeyboard: (active: boolean) => void;
  onPermission?: (kind: "accessibility" | "screen_recording") => void;
}

export function collapsedWidth(g: NotchGeometry): number {
  return g.notchWidth + 2 * g.earWidth;
}

function Pane(props: NotchViewProps & { state: NotchState }) {
  const { state, screen } = props;
  switch (screen.kind) {
    case "agent":
      return (
        <NotchThread
          key={screen.channel}
          state={state}
          screen={screen}
          composer={props.composer}
          sending={props.sending}
          voiceAvailable={props.voiceAvailable}
          selectedId={props.selectedId}
          answering={props.answering}
          onSelect={props.onSelect}
          onAnswer={props.onAnswer}
          onReply={props.onReply}
          onSend={props.onSend}
          onOpen={props.onOpen}
          onCompose={props.onCompose}
          onComposerText={props.onComposerText}
          onComposerSubmit={props.onComposerSubmit}
          onComposerCancel={props.onComposerCancel}
          onVoice={props.onVoice}
          onKeyboard={props.onKeyboard}
          onStop={props.onStop}
          onPermission={props.onPermission}
          voice={props.voice}
          talking={props.talking}
        />
      );
    case "sessions":
      return (
        <SessionsPane
          state={state}
          now={props.now}
          onPick={props.onPick}
          onShowSource={props.onShowSource}
        />
      );
    case "new": {
      const lead = state.agents.find((a) => a.is_lead);
      return (
        <NewBotPane
          leadSlug={state.lead ?? "cos"}
          leadName={state.lead_name || "Chief of Staff"}
          leadAvatar={lead?.avatar}
          sending={props.sending}
          onSubmit={props.onNewBotSubmit}
        />
      );
    }
    default:
      return (
        <NotchIdeas
          ideas={state.ideas ?? { enabled: false, items: [] }}
          onOpen={props.onOpen}
        />
      );
  }
}

/** What the open notch holds: the hover list, Settings, or Home. */
function OpenBody(props: NotchViewProps) {
  const { state } = props;
  if (!state) return <p className="nchat-empty">Waking the office…</p>;
  if (props.mode === "peek") {
    return (
      <NotchPeek
        state={state}
        now={props.now}
        onPick={props.onPick}
        onExpand={props.onExpand}
        onHeight={props.onPeekHeight}
      />
    );
  }
  if (props.screen.kind === "settings") {
    return (
      <NotchSettings
        state={state}
        onBack={props.onBack}
        onOpen={props.onOpen}
      />
    );
  }
  return (
    <div className="nhome" data-testid="notch-home">
      <NotchSidebar
        state={state}
        current={props.screen}
        now={props.now}
        onPick={props.onPick}
        onNewBot={props.onNewBot}
        onSettings={props.onSettings}
        onOpenFull={props.onOpenFull}
      />
      <div className="nhome-pane">
        {props.error ? (
          <p className="nerror" role="alert">
            {props.error}
          </p>
        ) : null}
        <Pane {...props} state={state} />
      </div>
    </div>
  );
}

export function NotchView(props: NotchViewProps) {
  const { geometry, expanded, state, mode } = props;
  // Every notch avatar looks its runtime up by slug, so the strip, the
  // rows and the chat carry the same badge.
  const runtimes = useMemo(() => {
    const map = new Map<string, BotRuntime>();
    for (const agent of state?.agents ?? []) {
      if (agent.runtime?.harness) map.set(agent.slug, agent.runtime);
    }
    return map;
  }, [state?.agents]);
  const runtimeOf = useCallback(
    (slug: string) => runtimes.get(slug),
    [runtimes],
  );
  const stripH = geometry.notchHeight + geometry.band;
  const openWidth =
    mode === "peek" ? PEEK_WIDTH : (geometry.expandedWidth ?? EXPANDED_WIDTH);
  const openHeight = geometry.expandedHeight ?? EXPANDED_HEIGHT;
  const width = expanded
    ? Math.max(openWidth, collapsedWidth(geometry))
    : collapsedWidth(geometry);
  // The hover list is as tall as its rows; the app fits the panel to it.
  const height: number | "auto" = !expanded
    ? stripH
    : mode === "peek"
      ? "auto"
      : openHeight;
  return (
    <BotRuntimeContext.Provider value={runtimeOf}>
      <div
        className={`notch-root${geometry.nativeGlass ? " has-native-glass" : ""}`}
        style={{
          ["--notch-strip-h" as string]: `${stripH}px`,
          height,
        }}
      >
        <div
          className={`notch-shell ${expanded ? "is-expanded" : "is-collapsed"} is-${mode}`}
          style={{ width, height }}
          data-testid="notch-shell"
          data-mood={state?.mood ?? "idle"}
        >
          <NotchStrip
            state={state}
            geometry={geometry}
            gang={props.gang}
            boredom={props.boredom}
            expanded={expanded}
          />
          {expanded ? <OpenBody {...props} /> : null}
        </div>
      </div>
    </BotRuntimeContext.Provider>
  );
}
