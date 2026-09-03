// Data hooks for the Computer tab. One status poll per mounted tab, mirrored
// into the zustand store so SSE frames and the poll share a single truth.
import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  COMPUTER_RUNTIME_QUERY_KEY,
  type ComputerAction,
  type ComputerMemberSetting,
  type ComputerStatus,
  computerAction,
  computerControl,
  computerJoin,
  computerQueryKey,
  getComputer,
  getComputerRuntime,
  prepareComputerRuntime,
  updateMemberComputer,
} from "../../../api/computer";
import { useAppStore } from "../../../stores/app";
import { showNotice } from "../../ui/Toast";
import { BUSY_PHASES, type ComputerPhase } from "./computerPhase";

export const COMPUTER_POLL_MS = 5000;
const RUNTIME_BUILD_POLL_MS = 3000;

export function useComputerStatus(slug: string) {
  const recordComputerEvent = useAppStore((s) => s.recordComputerEvent);
  const query = useQuery({
    queryKey: computerQueryKey(slug),
    queryFn: () => getComputer(slug),
    refetchInterval: COMPUTER_POLL_MS,
    // Always refetch on mount: a remount after a lifecycle action must not
    // serve the pre-action status from cache.
    staleTime: 0,
  });

  const { data } = query;
  useEffect(() => {
    if (!data) return;
    recordComputerEvent(mirrorStatus(data));
  }, [data, recordComputerEvent]);

  return query;
}

/** Translate a settled status into the SSE payload shape the store takes. */
export function mirrorStatus(status: ComputerStatus) {
  return {
    slug: status.slug,
    state: status.state,
    problem: status.problem ?? undefined,
    held: status.control.held,
    help_reason: status.control.helpReason,
    frame: status.lastFrame?.dataUrl,
    at: status.lastFrame?.at,
  };
}

export function useComputerRuntime(enabled: boolean, building: boolean) {
  return useQuery({
    queryKey: COMPUTER_RUNTIME_QUERY_KEY,
    queryFn: getComputerRuntime,
    enabled,
    refetchInterval: building ? RUNTIME_BUILD_POLL_MS : false,
    staleTime: 10_000,
  });
}

export function useComputerMutations(slug: string) {
  const queryClient = useQueryClient();
  const recordComputerEvent = useAppStore((s) => s.recordComputerEvent);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: computerQueryKey(slug) });
  };

  const lifecycle = useMutation({
    mutationKey: ["computer-action", slug],
    mutationFn: (action: ComputerAction) => computerAction(slug, action),
    onSuccess: (status) => {
      recordComputerEvent(mirrorStatus(status));
      invalidate();
    },
  });

  const prepare = useMutation({
    mutationKey: ["computer-prepare"],
    mutationFn: prepareComputerRuntime,
    onSuccess: () => {
      // The build streams over SSE; flag it locally so the tab flips to the
      // building phase before the first progress line lands.
      recordComputerEvent({ slug: "", state: "building" });
      void queryClient.invalidateQueries({
        queryKey: COMPUTER_RUNTIME_QUERY_KEY,
      });
      invalidate();
    },
  });

  const takeControl = useMutation({
    mutationKey: ["computer-take-control", slug],
    mutationFn: async () => {
      await computerControl(slug, "take");
      const { viewerUrl } = await computerJoin(slug);
      return viewerUrl;
    },
    onSuccess: () => {
      recordComputerEvent({
        slug,
        state: "",
        held: true,
        help_reason: null,
      });
      invalidate();
    },
  });

  const releaseControl = useMutation({
    mutationKey: ["computer-release-control", slug],
    mutationFn: () => computerControl(slug, "release"),
    onSuccess: (control) => {
      recordComputerEvent({
        slug,
        state: "",
        held: control.held,
        help_reason: control.helpReason,
      });
      invalidate();
    },
  });

  const dismissHelp = useMutation({
    mutationKey: ["computer-dismiss-help", slug],
    mutationFn: () => computerControl(slug, "dismiss-help"),
    onSuccess: (control) => {
      recordComputerEvent({
        slug,
        state: "",
        held: control.held,
        help_reason: control.helpReason,
      });
      invalidate();
    },
  });

  const runsOn = useMutation({
    mutationKey: ["computer-runs-on", slug],
    mutationFn: (computer: ComputerMemberSetting) =>
      updateMemberComputer(slug, computer),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["office-members"] });
      invalidate();
    },
  });

  return {
    lifecycle,
    prepare,
    takeControl,
    releaseControl,
    dismissHelp,
    runsOn,
  };
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export interface ComputerTabActions {
  empty: {
    prepare: () => void;
    provision: () => void;
    start: () => void;
    /** Remove a refused or stale computer and create it again. */
    replace: () => void;
    pending: boolean;
  };
  takeControl: () => void;
  handBack: () => void;
  dismissHelp: () => void;
  sleep: () => void;
  remove: () => void;
  setRunsOn: (next: ComputerMemberSetting) => void;
  controlPending: boolean;
  runsOnPending: boolean;
}

/**
 * The tab's button handlers: every mutation, with a toast on failure and
 * the control viewer swap on a successful take. Keeps ComputerTab to layout.
 */
export function useComputerTabActions(
  slug: string,
  phase: ComputerPhase,
  setControlViewerUrl: (url: string | null) => void,
): ComputerTabActions {
  const m = useComputerMutations(slug);
  const {
    lifecycle,
    prepare,
    takeControl,
    releaseControl,
    dismissHelp,
    runsOn,
  } = m;

  const runLifecycle = useCallback(
    (action: ComputerAction) => {
      lifecycle.mutate(action, {
        onError: (err) =>
          showNotice(errorText(err, "The computer did not respond"), "error"),
      });
    },
    [lifecycle],
  );

  const controlPending =
    takeControl.isPending ||
    releaseControl.isPending ||
    dismissHelp.isPending ||
    lifecycle.isPending;
  const emptyPending =
    controlPending || prepare.isPending || BUSY_PHASES.has(phase);

  return useMemo(
    () => ({
      empty: {
        prepare: () =>
          prepare.mutate(undefined, {
            onError: (err) =>
              showNotice(
                errorText(err, "Could not start the image build"),
                "error",
              ),
          }),
        provision: () => runLifecycle("provision"),
        start: () => runLifecycle("start"),
        replace: () =>
          lifecycle.mutate("remove", {
            onSuccess: () => runLifecycle("provision"),
            onError: (err) =>
              showNotice(
                errorText(err, "Could not remove the computer"),
                "error",
              ),
          }),
        pending: emptyPending,
      },
      takeControl: () =>
        takeControl.mutate(undefined, {
          onSuccess: (viewerUrl) => setControlViewerUrl(viewerUrl || null),
          onError: (err) =>
            showNotice(errorText(err, "Could not take control"), "error"),
        }),
      handBack: () =>
        releaseControl.mutate(undefined, {
          onSuccess: () => setControlViewerUrl(null),
          onError: (err) =>
            showNotice(errorText(err, "Could not hand control back"), "error"),
        }),
      dismissHelp: () =>
        dismissHelp.mutate(undefined, {
          onError: (err) =>
            showNotice(
              errorText(err, "Could not dismiss the request"),
              "error",
            ),
        }),
      sleep: () => runLifecycle("sleep"),
      remove: () => runLifecycle("remove"),
      setRunsOn: (next: ComputerMemberSetting) =>
        runsOn.mutate(next, {
          onError: (err) =>
            showNotice(
              errorText(err, "Could not update where it runs"),
              "error",
            ),
        }),
      controlPending,
      runsOnPending: runsOn.isPending,
    }),
    [
      prepare,
      takeControl,
      releaseControl,
      dismissHelp,
      runsOn,
      runLifecycle,
      controlPending,
      emptyPending,
      setControlViewerUrl,
    ],
  );
}
