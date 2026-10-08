import { NotchPanel, type PanelProps } from "./NotchPanel";
import {
  NotchStage,
  NotchStrip,
  type StripProps,
  stageHeight,
} from "./NotchStrip";
import type { NotchGeometry } from "./types";

// Presentational notch: the strip (always) and the panel (when open), inside
// one black shell that grows out of the camera housing. NotchApp owns the
// data, timers, sounds and the native bridge.

export const EXPANDED_WIDTH = 460;
export const EXPANDED_HEIGHT = 560;

export type NotchViewProps = Omit<StripProps, "expanded"> &
  Omit<PanelProps, "state"> & {
    geometry: NotchGeometry;
    expanded: boolean;
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
    expanded,
  });
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
        expanded={expanded}
      />
      <div
        className={`notch-shell ${expanded ? "is-expanded" : "is-collapsed"}`}
        style={{
          width,
          height: expanded ? EXPANDED_HEIGHT : geometry.notchHeight,
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
          expanded={expanded}
        />
        {expanded ? <NotchPanel {...props} state={state} /> : null}
      </div>
    </div>
  );
}
