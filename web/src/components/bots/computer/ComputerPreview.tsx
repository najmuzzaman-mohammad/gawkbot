// "<name>'s screen": the 16:10 box. Live noVNC iframe when the desktop is
// ready and the broker handed us a signed viewer URL, the latest frame
// otherwise, and the phase's empty state when there is no picture at all.
import type { ComputerRuntime } from "../../../api/computer";
import {
  ComputerEmptyState,
  type EmptyStateActions,
} from "./ComputerEmptyState";
import {
  type ComputerPhase,
  destinationLabel,
  showsFrame,
} from "./computerPhase";

interface ComputerPreviewProps {
  name: string;
  phase: ComputerPhase;
  destination: "off" | "sandbox" | "cloud" | undefined;
  /** Signed viewer page. Control-policy URL wins while the person drives. */
  viewerUrl: string | null;
  frameDataUrl: string | null;
  problem: string | null;
  runtime: ComputerRuntime | undefined;
  actions: EmptyStateActions;
}

export const VIEWER_SANDBOX = "allow-scripts allow-same-origin allow-forms";

export function ComputerPreview({
  name,
  phase,
  destination,
  viewerUrl,
  frameDataUrl,
  problem,
  runtime,
  actions,
}: ComputerPreviewProps) {
  const label = destinationLabel(destination);
  const live = phase === "ready" && viewerUrl;
  const frame = !live && showsFrame(phase) && frameDataUrl;

  return (
    <section className="computer-preview" aria-label={`${name}'s screen`}>
      <div className="computer-preview-header">
        <span className="computer-preview-title">{`${name}'s screen`}</span>
        {label ? (
          <span
            className="computer-preview-destination"
            data-testid="computer-destination"
          >
            {label}
          </span>
        ) : null}
      </div>
      <div className="computer-screen" data-phase={phase}>
        {live ? (
          <iframe
            title={`${name}'s screen`}
            src={viewerUrl}
            sandbox={VIEWER_SANDBOX}
            className="computer-viewer"
            data-testid="computer-viewer"
          />
        ) : frame ? (
          <>
            <img
              src={frameDataUrl}
              alt={`${name}'s screen`}
              className={`computer-frame${phase === "ready" ? "" : " is-stale"}`}
              data-testid="computer-frame"
            />
            {phase !== "ready" ? (
              <div className="computer-screen-overlay">
                <ComputerEmptyState
                  phase={phase}
                  name={name}
                  problem={problem}
                  runtime={runtime}
                  actions={actions}
                />
              </div>
            ) : null}
          </>
        ) : (
          <ComputerEmptyState
            phase={phase}
            name={name}
            problem={problem}
            runtime={runtime}
            actions={actions}
          />
        )}
      </div>
    </section>
  );
}
