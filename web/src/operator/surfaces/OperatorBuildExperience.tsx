// OperatorBuildExperience — the new-app build flow as a right-docked chat beside
// a live view of the app being built (replaces the old full-screen builder).
//
// Describe the app in the chat. The moment the build scaffolds, the chat docks
// to the right and the main area shows the app's LIVE preview on the UI tab —
// the UI builds in front of you. Once it publishes, the detail walks UI →
// Workflow → Data → Knowledge so each part is seen getting hooked up.

import { useState } from "react";
import { Sparkles, X } from "lucide-react";

import type { DemoCapture } from "../apps/demoCapture";
import { AppBuilderChat } from "./AppBuilderChat";
import { OperatorAppDetail } from "./OperatorAppDetail";

interface OperatorBuildExperienceProps {
  onClose: () => void;
  onFinish: (appId: string) => void;
  /**
   * A "Demo workflow to Nex" call's capture: the build starts from it at once
   * (no describe step), and the captured routine + tools get set up on the new
   * agent as it builds.
   */
  demo?: DemoCapture;
  /**
   * Edit mode: the chat opens scoped to an EXISTING app (AppBuilderChat's
   * editApp → the broker improve path) with the live app already docked
   * beside it, so a change request republishes a new version in place.
   */
  editApp?: { id: string; name: string };
  /** Onboarding's first-workflow text — sent the moment the chat mounts. */
  initialPrompt?: string;
}

export function OperatorBuildExperience({
  onClose,
  onFinish,
  demo,
  editApp,
  initialPrompt,
}: OperatorBuildExperienceProps) {
  // Set the instant the build scaffolds; flips the layout from a centered
  // describe chat to "live preview + docked chat". Edit mode starts live:
  // the app already exists, so the preview docks immediately.
  const [buildingAppId, setBuildingAppId] = useState<string | null>(
    editApp?.id ?? null,
  );
  const live = Boolean(buildingAppId);

  return (
    <div className={`opr-build-exp${live ? " is-live" : ""}`}>
      {live && buildingAppId ? (
        <div className="opr-build-exp-main">
          <OperatorAppDetail
            key={buildingAppId}
            appId={buildingAppId}
            onBack={onClose}
            // The tab walk is a first-build ceremony; an edit republishes in
            // place, so the operator stays on the tab they are looking at.
            buildWalk={!editApp}
          />
        </div>
      ) : null}

      <aside className="opr-build-exp-chat">
        {live ? (
          <div className="opr-ask-bar">
            <span className="opr-ask-bar-title">
              <Sparkles size={13} strokeWidth={2} aria-hidden={true} />
              {editApp ? `Editing ${editApp.name}` : "Building your agent"}
            </span>
            <button
              type="button"
              className="opr-icon-btn"
              onClick={onClose}
              aria-label="Close builder"
              title="Close"
            >
              <X size={15} strokeWidth={1.9} aria-hidden={true} />
            </button>
          </div>
        ) : null}
        <div className={live ? "opr-ask-body" : "opr-build-exp-chat-full"}>
          <AppBuilderChat
            panelMode={live}
            demo={demo}
            initialPrompt={initialPrompt}
            editApp={editApp}
            onClose={onClose}
            onBuildingApp={setBuildingAppId}
            onFinish={onFinish}
          />
        </div>
      </aside>
    </div>
  );
}
