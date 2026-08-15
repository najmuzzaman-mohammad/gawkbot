// OperatorApp — the operator-MLP product shell, mounted full-bleed at
// /#/operator (see RootRoute). Navigation is local state. Apps are REAL: the
// "Build an app" flow drives the shipped app-builder backend, and an app's
// detail renders the live, persisted app in its UI tab. The mock workflow
// tooling (WorkflowBuilder, mock tools) stays reachable for the workflow-tab
// story we built earlier. See docs/specs/operator-mlp-plan.md.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import "../styles/operator-shell.css";

import { getConfig } from "../api/client";
import { useAgentNames } from "./agents/agentNames";
import { capturePromptSeed, type DemoCapture } from "./apps/demoCapture";
import {
  appBuildState,
  isRealAppId,
  useOperatorApps,
} from "./apps/useOperatorApps";
import { useRealtimeConfig } from "./apps/useRealtimeConfig";
import { ApprovalPrompt } from "./components/ApprovalPrompt";
import { CallModal } from "./components/CallModal";
import { RealCallModal } from "./components/RealCallModal";
import { consumeFirstWorkflowSeed } from "./firstWorkflowSeed";
import { getTool } from "./mock/data";
import {
  OperatorSidebar,
  type OperatorSurface,
  type SidebarAgent,
} from "./OperatorSidebar";
import { InternalToolDetail } from "./surfaces/InternalToolDetail";
import { InternalToolsSurface } from "./surfaces/InternalToolsSurface";
import { OperatorAppDetail } from "./surfaces/OperatorAppDetail";
import { OperatorBuildExperience } from "./surfaces/OperatorBuildExperience";
import { SettingsSurface } from "./surfaces/SettingsSurface";
import {
  type BuiltWorkflow,
  type FinishMode,
  WorkflowBuilder,
} from "./surfaces/WorkflowBuilder";

// The "Demo workflow to Nex" call runs in one of two modes: BUILD a new tool
// (the entry points in the sidebar / tools list / chats) or MODIFY an existing
// one (the peer-to-Ask-AI affordance on a tool detail, which carries the tool).
type CallContext =
  | { mode: "build" }
  | { mode: "modify"; toolId: string; toolName: string };

export function OperatorApp() {
  // The real voice call needs an OpenAI Realtime key; without one we fall back
  // to the scripted mock so the flow is still demonstrable.
  const realtime = useRealtimeConfig();
  const [surface, setSurface] = useState<OperatorSurface>("tools");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [call, setCall] = useState<CallContext | null>(null);
  // Freeze which call surface to use at the moment the call opens. Deriving it
  // from `realtime.available` every render lets a later config refetch (the
  // `/config` query refetches on window focus, or resolves late) swap the
  // component type for the same JSX position, unmounting the live WebRTC call.
  const [callIsReal, setCallIsReal] = useState(false);
  function openCall(ctx: CallContext) {
    setCallIsReal(realtime.available);
    setCall(ctx);
  }
  // Two builders: the app builder (primary, real) and the legacy workflow
  // builder (kept for the workflow-tab path).
  // Onboarding's first-workflow handoff: consumed once at mount. When present,
  // the shell opens straight into the build flow with the text already sent —
  // the user lands on their first agent being assembled, which is what the
  // "Start your first workflow" CTA promised.
  const [firstWorkflow] = useState<string | null>(() =>
    consumeFirstWorkflowSeed(),
  );
  const [appBuildingInit] = useState<boolean>(() => firstWorkflow !== null);
  const [appBuilding, setAppBuilding] = useState(appBuildingInit);
  // Set → the build experience opens in EDIT mode scoped to this app (the
  // "Edit app" affordance on the detail). Cleared with the rest of the
  // sub-state on close/finish.
  const [editingApp, setEditingApp] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [building, setBuilding] = useState(false);
  // The workflow just built in the builder, carried so its clarified steps
  // survive the handoff instead of falling back to the seeded mock.
  const [builtDraft, setBuiltDraft] = useState<BuiltWorkflow | null>(null);
  // "run" handoffs land on the Workflow tab (run history); plain opens stay UI.
  const [openOnWorkflowTab, setOpenOnWorkflowTab] = useState(false);
  // Bumped to force the tool detail to remount — used when a modify call ends on
  // the SAME tool it started from, so the detail re-opens with the AI already
  // working on the demonstrated change.
  const [detailNonce, setDetailNonce] = useState(0);
  // Seeds handed to the build engine by a "Demo workflow to Nex" call so the AI
  // starts working from the captured context: demoBuild feeds a fresh AGENT
  // build (the real app-builder, plus the captured routine/tools); demoSeed
  // feeds the chat scoped to the tool being modified.
  const [buildSeed, setBuildSeed] = useState<string | null>(null);
  const [demoBuild, setDemoBuild] = useState<DemoCapture | null>(null);
  const [demoSeed, setDemoSeed] = useState<string | null>(null);

  // The sidebar's collapsible Agents rail: REAL agents (broker apps) only,
  // renames applied. Nothing mock rides along — the rail is the operator's
  // actual inventory, and it is empty until they build something.
  const appsQuery = useOperatorApps();
  const nameOverrides = useAgentNames();
  // Office identity for the sidebar footer. Resolves to null on any failure so
  // an unreachable broker never breaks the shell (the sidebar falls back).
  const configQuery = useQuery({
    queryKey: ["operator-config"],
    queryFn: () => getConfig().catch(() => null),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const officeName = configQuery.data?.company_name;
  const sidebarAgents: SidebarAgent[] = (appsQuery.data ?? []).map((a) => ({
    id: a.id,
    name: nameOverrides[a.id] ?? a.name,
    glyph: a.icon || "🤖",
    building: appBuildState(a) === "building",
  }));

  function resetSubState() {
    setSelectedId(null);
    setAppBuilding(false);
    setEditingApp(null);
    setBuilding(false);
    setBuiltDraft(null);
    setOpenOnWorkflowTab(false);
    setBuildSeed(null);
    setDemoBuild(null);
    setDemoSeed(null);
  }

  function go(next: OperatorSurface) {
    setSurface(next);
    resetSubState();
  }

  function openTool(id: string) {
    resetSubState();
    setSelectedId(id);
    setSurface("tools");
  }

  function finishApp(appId: string) {
    resetSubState();
    setSelectedId(appId);
    setSurface("tools");
  }

  function finishWorkflow(draft: BuiltWorkflow, mode: FinishMode) {
    setBuiltDraft(draft);
    setSelectedId(draft.toolId);
    setSurface("tools");
    setBuilding(false);
    setAppBuilding(false);
    setOpenOnWorkflowTab(mode === "run");
  }

  const baseTool =
    selectedId && !isRealAppId(selectedId) ? getTool(selectedId) : undefined;
  // When the open came from the builder, overlay the built name + clarified
  // steps onto the base tool so the detail reflects what was actually built.
  const selectedTool =
    baseTool && builtDraft && builtDraft.toolId === selectedId
      ? {
          ...baseTool,
          name: builtDraft.name,
          steps: builtDraft.steps,
          status: "draft" as const,
        }
      : baseTool;

  function renderSurface() {
    if (surface === "settings") return <SettingsSurface />;
    if (isRealAppId(selectedId)) {
      return (
        <OperatorAppDetail
          key={selectedId}
          appId={selectedId as string}
          onBack={() => setSelectedId(null)}
          onEditApp={setEditingApp}
        />
      );
    }
    if (selectedTool) {
      return (
        <InternalToolDetail
          key={`${selectedTool.id}:${detailNonce}`}
          tool={selectedTool}
          onBack={() => setSelectedId(null)}
          onStartCall={() =>
            openCall({
              mode: "modify",
              toolId: selectedTool.id,
              toolName: selectedTool.name,
            })
          }
          initialTab={openOnWorkflowTab ? "workflow" : "ui"}
          demoSeed={demoSeed ?? undefined}
        />
      );
    }
    return (
      <InternalToolsSurface
        onOpen={openTool}
        onBuild={() => setAppBuilding(true)}
      />
    );
  }

  return (
    <div className="opr-root" data-testid="operator-root">
      <OperatorSidebar
        active={surface}
        onSelect={go}
        onStartCall={() => openCall({ mode: "build" })}
        onBuild={() => setAppBuilding(true)}
        agents={sidebarAgents}
        activeAgentId={selectedId}
        onOpenAgent={openTool}
        officeName={officeName}
      />

      <main className="opr-main">
        {appBuilding || editingApp ? (
          <OperatorBuildExperience
            key={editingApp?.id ?? "new"}
            demo={demoBuild ?? undefined}
            initialPrompt={firstWorkflow ?? undefined}
            editApp={editingApp ?? undefined}
            onClose={() => {
              setAppBuilding(false);
              setEditingApp(null);
            }}
            onFinish={finishApp}
          />
        ) : building ? (
          <WorkflowBuilder
            seed={buildSeed ?? undefined}
            onClose={() => setBuilding(false)}
            onFinish={finishWorkflow}
          />
        ) : (
          <div className="opr-surface">{renderSurface()}</div>
        )}
      </main>

      {/* Auto-surfaced approvals (e.g. an app's Slack post) — global overlay. */}
      <ApprovalPrompt />

      {call
        ? (() => {
            // Real call when a Realtime key was configured at call start; mock
            // otherwise. `callIsReal` is pinned when the call opens so a later
            // config refetch can't swap the component and drop a live call.
            // ONLY the real call hands a capture to the build engine — the
            // scripted example ends into the plain build chat with an empty
            // composer (2026-08-15 audit: a fabricated capture was building
            // real agents for a demo that never happened).
            const toolProp =
              call.mode === "modify"
                ? { id: call.toolId, name: call.toolName }
                : undefined;
            if (callIsReal) {
              return (
                <RealCallModal
                  tool={toolProp}
                  onClose={() => setCall(null)}
                  onBuild={(capture) => {
                    // The call captured everything; hand it to the AI, which
                    // starts working at once. A modify call reopens the tool
                    // with its chat already reworking the demonstrated change;
                    // a build call opens the REAL agent build (the app-builder
                    // engine), which also sets up the captured tools.
                    const seed = capturePromptSeed(capture);
                    resetSubState();
                    setCall(null);
                    if (capture.mode === "modify" && capture.toolId) {
                      setDemoSeed(seed);
                      setSelectedId(capture.toolId);
                      setSurface("tools");
                      setDetailNonce((n) => n + 1);
                    } else {
                      setDemoBuild(capture);
                      setAppBuilding(true);
                      setSurface("tools");
                    }
                  }}
                />
              );
            }
            return (
              <CallModal
                tool={toolProp}
                onClose={() => setCall(null)}
                onDescribe={() => {
                  // Watchable example over — the operator does it for real, in
                  // their own words. No seed, no fabricated capture.
                  resetSubState();
                  const modifyTool =
                    call.mode === "modify" ? call.toolId : null;
                  setCall(null);
                  if (modifyTool) {
                    setSelectedId(modifyTool);
                    setSurface("tools");
                    setDetailNonce((n) => n + 1);
                  } else {
                    setAppBuilding(true);
                    setSurface("tools");
                  }
                }}
              />
            );
          })()
        : null}
    </div>
  );
}
