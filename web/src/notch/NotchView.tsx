import { useCallback, useMemo } from "react";

import { type BotRuntime, BotRuntimeContext } from "../lib/botRuntime";
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
  // Every notch avatar looks its runtime up by slug, so the strip, the
  // panel rows and the question cards all carry the same badge.
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
  const width = expanded
    ? Math.max(EXPANDED_WIDTH, collapsedWidth(geometry))
    : collapsedWidth(geometry);
  const stage = stageHeight({
    line: props.line,
    peeker: props.peeker,
    arrival: props.arrival,
    expanded,
  });
  return (
    <BotRuntimeContext.Provider value={runtimeOf}>
      <div
        className={`notch-root${geometry.nativeGlass ? " has-native-glass" : ""}`}
        style={{
          ["--notch-strip-h" as string]: `${geometry.notchHeight + geometry.band}px`,
          height: expanded
            ? EXPANDED_HEIGHT
            : geometry.notchHeight + geometry.band + stage,
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
            height: expanded
              ? EXPANDED_HEIGHT
              : geometry.notchHeight + geometry.band,
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
          {expanded ? <NotchPanel {...props} state={state} /> : null}
        </div>
      </div>
    </BotRuntimeContext.Provider>
  );
}
