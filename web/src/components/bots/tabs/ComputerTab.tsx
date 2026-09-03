/**
 * Computer tab — this bot's own desktop, and you can watch.
 *
 * Reads one status poll (5 s) plus the `computer` SSE stream mirrored into
 * the app store, and renders the OpenMausBot-style panel: the screen, who is
 * driving, where it runs, and a small console. Every phase is honest: the
 * tab never shows a desktop the broker did not report.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { OfficeMember } from "../../../api/client";
import { useAppStore } from "../../../stores/app";
import { BoxCloudAccountCard } from "../../computer/BoxCloudAccountCard";
import { BoxCloudConnect } from "../../computer/BoxCloudConnect";
import { ComputerConsole } from "../computer/ComputerConsole";
import { ComputerDriving } from "../computer/ComputerDriving";
import {
  invalidateAfterBoxChange,
  RuntimeMissingPaths,
} from "../computer/ComputerEmptyState";
import { ComputerPreview } from "../computer/ComputerPreview";
import { ComputerRunsOn } from "../computer/ComputerRunsOn";
import { deriveComputerView } from "../computer/computerPhase";
import {
  useComputerRuntime,
  useComputerStatus,
  useComputerTabActions,
} from "../computer/useComputer";

interface ComputerTabProps {
  agent: OfficeMember;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function ComputerTab({ agent }: ComputerTabProps) {
  const { slug } = agent;
  const name = agent.name || agent.slug;

  const { data: status, isError, error } = useComputerStatus(slug);
  const live = useAppStore((s) => s.computerStates[slug]);
  const runtimeBuild = useAppStore((s) => s.computerRuntimeBuild);

  const view = deriveComputerView({ status, live, runtimeBuild });
  const { phase } = view;
  const needsRuntime =
    phase === "runtime_missing" ||
    phase === "image_missing" ||
    phase === "building";
  const { data: runtime } = useComputerRuntime(
    needsRuntime,
    phase === "building",
  );

  // The control-policy viewer replaces the view-policy one while the person
  // holds the wheel. Local to the tab: the broker does not hand it back on
  // the status poll, and it expires with the hold.
  const [controlViewerUrl, setControlViewerUrl] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const actions = useComputerTabActions(slug, phase, setControlViewerUrl);

  useEffect(() => {
    if (!view.held) setControlViewerUrl(null);
  }, [view.held]);

  const problem =
    phase === "building" || phase === "image_missing"
      ? (view.problem ?? runtime?.problem ?? null)
      : view.problem;

  return (
    <div className="computer-tab" data-testid="computer-tab">
      {isError ? (
        <div className="computer-card computer-card--error" role="alert">
          {errorText(error, "Could not load this bot's computer")}
        </div>
      ) : null}

      <ComputerPreview
        name={name}
        phase={phase}
        destination={status?.destination}
        viewerUrl={controlViewerUrl ?? status?.viewerUrl ?? null}
        frameDataUrl={view.frameDataUrl}
        problem={problem}
        runtime={runtime}
        actions={actions.empty}
      />

      {phase === "runtime_missing" ? (
        <RuntimeMissingPaths slug={slug} runtime={runtime} />
      ) : null}

      {phase === "unconfigured" ? (
        <div className="computer-card">
          <div className="computer-card-text computer-card-text--secondary">
            Connect ascii.dev to give this bot a cloud computer. It spins up
            right here on your account.
          </div>
          <BoxCloudConnect
            compact={true}
            onChanged={() => invalidateAfterBoxChange(queryClient, slug)}
          />
        </div>
      ) : null}

      {status?.destination === "cloud" && phase !== "unconfigured" ? (
        <BoxCloudAccountCard slug={slug} />
      ) : null}

      {phase === "ready" ? (
        <ComputerDriving
          name={name}
          held={view.held}
          helpReason={view.helpReason}
          busy={status?.busy ?? false}
          destination={status?.destination}
          pending={actions.controlPending}
          onTakeControl={actions.takeControl}
          onHandBack={actions.handBack}
          onDismissHelp={actions.dismissHelp}
          onSleep={actions.sleep}
          onRemove={actions.remove}
        />
      ) : null}

      <ComputerRunsOn
        setting={agent.computer ?? ""}
        effective={status?.destination}
        pending={actions.runsOnPending}
        onChange={actions.setRunsOn}
      />

      {phase === "ready" ? <ComputerConsole slug={slug} /> : null}
    </div>
  );
}
