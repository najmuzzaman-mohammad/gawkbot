import { type BlindPhase, NotchBlind, VALANCE } from "./NotchBlind";
import { NotchPanel, type PanelProps } from "./NotchPanel";
import {
  NotchStage,
  NotchStrip,
  type StripProps,
  stageHeight,
} from "./NotchStrip";
import type { NotchGeometry } from "./types";

// Presentational notch: the strip (always), and when open a roller blind
// that a character pulls down out of it with the panel printed on the
// fabric (NotchBlind). The black shell grows a valance for the roller.
// NotchApp owns the data, timers, sounds and the native bridge.

/** Keep equal to kExpandedWidth / kExpandedHeight in notch_darwin.m. */
export const EXPANDED_WIDTH = 460;
export const EXPANDED_HEIGHT = 660;

export type NotchViewProps = Omit<StripProps, "expanded"> &
  Omit<PanelProps, "state"> & {
    geometry: NotchGeometry;
    expanded: boolean;
    /** Bumped when an answer lands: the lead gives a thumbs-up. */
    cheer?: number;
    /** Where the blind's short is (NotchApp sizes the stage from it). */
    blindPhase?: BlindPhase;
    onBlindPhase?: (phase: BlindPhase) => void;
  };

export function collapsedWidth(g: NotchGeometry): number {
  return g.notchWidth + 2 * g.earWidth;
}

export function NotchView(props: NotchViewProps) {
  const { geometry, expanded, state } = props;
  const width = expanded
    ? Math.max(EXPANDED_WIDTH, collapsedWidth(geometry))
    : collapsedWidth(geometry);
  const stage = stageHeight({
    line: props.line,
    peeker: props.peeker,
    arrival: props.arrival,
    relief: props.blindPhase === "relief" || props.blindPhase === "closing",
    expanded,
  });
  const lead = state?.agents.find((a) => a.is_lead);
  return (
    <div
      className="notch-root"
      style={{
        height: expanded ? EXPANDED_HEIGHT : geometry.notchHeight + stage,
      }}
    >
      <NotchStage
        state={state}
        geometry={geometry}
        gang={props.gang}
        boredom={props.boredom}
        line={props.line}
        peeker={props.peeker}
        arrival={props.arrival}
        expanded={expanded}
      />
      <div
        className={`notch-shell ${expanded ? "is-expanded" : "is-collapsed"}`}
        style={{
          width,
          height: geometry.notchHeight + (expanded ? VALANCE : 0),
        }}
        data-testid="notch-shell"
        data-mood={state?.mood ?? "idle"}
      >
        <NotchStrip
          state={state}
          geometry={geometry}
          gang={props.gang}
          boredom={props.boredom}
          line={props.line}
          peeker={props.peeker}
          arrival={props.arrival}
          expanded={expanded}
        />
      </div>
      <NotchBlind
        expanded={expanded}
        width={EXPANDED_WIDTH}
        height={EXPANDED_HEIGHT}
        notchHeight={geometry.notchHeight}
        leadSlug={lead?.slug ?? state?.lead ?? "cos"}
        leadAvatar={lead?.avatar}
        cheer={props.cheer ?? 0}
        onPhase={props.onBlindPhase}
      >
        <NotchPanel {...props} state={state} />
      </NotchBlind>
    </div>
  );
}
