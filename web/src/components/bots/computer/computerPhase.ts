// Pure helpers behind the Computer tab: which phase the UI is in and the
// copy for each one. Kept free of React so the phase table is testable on
// its own and the components stay small.
import type {
  ComputerDestination,
  ComputerState,
  ComputerStatus,
} from "../../../api/computer";
import { isComputerState } from "../../../api/computer";
import type {
  ComputerLiveState,
  ComputerRuntimeBuild,
} from "../../../stores/app";

/** `loading` is the UI-only phase before the first status answer lands. */
export type ComputerPhase = "loading" | ComputerState;

export const ORBSTACK_URL = "https://orbstack.dev";

/** Phases where the desktop exists and a frame is worth showing. */
const FRAME_PHASES: ReadonlySet<ComputerPhase> = new Set<ComputerPhase>([
  "ready",
  "asleep",
  "starting",
  "waking",
  "provisioning",
]);

/** Phases with an in-flight lifecycle transition. */
export const BUSY_PHASES: ReadonlySet<ComputerPhase> = new Set<ComputerPhase>([
  "loading",
  "building",
  "provisioning",
  "starting",
  "waking",
]);

interface ResolvePhaseInput {
  status: ComputerStatus | undefined;
  live: ComputerLiveState | undefined;
  runtimeBuilding: boolean;
}

/**
 * The live store is written by both SSE and the status poll, so it is at
 * least as fresh as the status. Fall back to the status for the first
 * render before the poll has been mirrored into the store.
 */
export function resolveComputerPhase({
  status,
  live,
  runtimeBuilding,
}: ResolvePhaseInput): ComputerPhase {
  const raw = live?.state || status?.state;
  if (!raw) return "loading";
  const phase: ComputerPhase = isComputerState(raw) ? raw : "error";
  // A shared image build in progress is what the user is waiting on, no
  // matter which bot's tab they are looking at.
  if (phase === "image_missing" && runtimeBuilding) return "building";
  return phase;
}

export interface ComputerView {
  phase: ComputerPhase;
  held: boolean;
  helpReason: string | null;
  frameDataUrl: string | null;
  problem: string | null;
}

/**
 * One merged read of "what is true right now" for the tab. The store wins
 * over the status because the poll is mirrored into it; the status fills in
 * only before that first mirror. Image-build failures arrive on the
 * machine-wide (slug "") stream, so that problem is used while the image is
 * the blocker.
 */
export function deriveComputerView({
  status,
  live,
  runtimeBuild,
}: {
  status: ComputerStatus | undefined;
  live: ComputerLiveState | undefined;
  runtimeBuild: ComputerRuntimeBuild;
}): ComputerView {
  const phase = resolveComputerPhase({
    status,
    live,
    runtimeBuilding: runtimeBuild.building,
  });
  const imageBlocked = phase === "building" || phase === "image_missing";
  return {
    phase,
    held: live?.held ?? status?.control.held ?? false,
    helpReason: live?.helpReason ?? status?.control.helpReason ?? null,
    frameDataUrl: live?.frameDataUrl ?? status?.lastFrame?.dataUrl ?? null,
    problem: imageBlocked
      ? runtimeBuild.problem
      : (live?.problem ?? status?.problem ?? null),
  };
}

export function showsFrame(phase: ComputerPhase): boolean {
  return FRAME_PHASES.has(phase);
}

export function destinationLabel(
  destination: ComputerDestination | undefined,
): string {
  if (destination === "sandbox") return "Local VM";
  if (destination === "cloud") return "cloud";
  return "";
}

export interface PhaseCopy {
  title: string;
  hint?: string;
}

/** Headline and hint for the preview area when there is no picture. */
export function phaseCopy(phase: ComputerPhase, name: string): PhaseCopy {
  switch (phase) {
    case "loading":
      return { title: "Checking on this computer…" };
    case "off":
      return {
        title: "This bot's computer is off",
        hint: "Pick where it runs below to turn it on.",
      };
    case "unconfigured":
      return {
        title: "No cloud computer configured",
        hint: "Add an ascii.dev Box key below and it spins up right here.",
      };
    case "runtime_missing":
      return {
        title: "No container runtime on this machine",
        hint: "A bot computer needs somewhere to run. Pick a path below.",
      };
    case "image_missing":
      return {
        title: "The desktop image is not built yet",
        hint: "First time only, about two minutes. Shared by every bot.",
      };
    case "building":
      return {
        title: "Building the desktop image",
        hint: "First time only, about two minutes.",
      };
    case "missing":
      return {
        title: `${name} does not have a computer yet`,
        hint: "Create one and it stays around between turns.",
      };
    case "provisioning":
      return { title: `Creating ${name}'s computer…` };
    case "starting":
      return { title: `Starting ${name}'s computer…` };
    case "waking":
      return { title: `Waking ${name}'s computer…` };
    case "ready":
      return { title: "Waiting for the first frame…" };
    case "asleep":
      return {
        title: `${name}'s computer is asleep`,
        hint: "It wakes on its own when a turn needs it.",
      };
    case "error":
      return { title: "Couldn't reach the computer" };
    default: {
      const _exhaustive: never = phase;
      void _exhaustive;
      return { title: "" };
    }
  }
}

/** Human label for the segmented "Runs on" picker. */
export const RUNS_ON_OPTIONS: ReadonlyArray<{
  value: "cloud" | "sandbox" | "off";
  label: string;
}> = [
  { value: "cloud", label: "Cloud" },
  { value: "sandbox", label: "Local VM" },
  { value: "off", label: "Off" },
];
