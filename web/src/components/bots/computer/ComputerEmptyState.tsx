// What the 16:10 preview shows when there is no picture: one honest line
// per phase plus the single action that moves it forward.
import { useState } from "react";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Cloud, Computer, Laptop, OpenNewWindow } from "iconoir-react";

import { getConfig, updateConfig } from "../../../api/client";
import {
  COMPUTER_RUNTIME_QUERY_KEY,
  type ComputerRuntime,
  computerQueryKey,
} from "../../../api/computer";
import { keyedByOccurrence } from "../../../lib/reactKeys";
import { useAppStore } from "../../../stores/app";
import { BoxCloudConnect } from "../../computer/BoxCloudConnect";
import { showNotice } from "../../ui/Toast";
import { type ComputerPhase, ORBSTACK_URL, phaseCopy } from "./computerPhase";

export interface EmptyStateActions {
  prepare: () => void;
  provision: () => void;
  start: () => void;
  pending: boolean;
  replace: () => void;
}

interface ComputerEmptyStateProps {
  phase: ComputerPhase;
  name: string;
  problem: string | null;
  runtime: ComputerRuntime | undefined;
  actions: EmptyStateActions;
}

function PowerGlyph() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v9" />
      <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
    </svg>
  );
}

function Spinner() {
  return <span className="computer-spinner" aria-hidden="true" />;
}

export function ComputerEmptyState({
  phase,
  name,
  problem,
  runtime,
  actions,
}: ComputerEmptyStateProps) {
  const copy = phaseCopy(phase, name);
  const spinning =
    phase === "loading" ||
    phase === "provisioning" ||
    phase === "starting" ||
    phase === "waking" ||
    phase === "building" ||
    phase === "ready";

  return (
    <div className="computer-empty" data-phase={phase}>
      <div className="computer-empty-glyph">
        {spinning ? (
          <Spinner />
        ) : phase === "off" ? (
          <PowerGlyph />
        ) : (
          <Computer width={22} height={22} aria-hidden="true" />
        )}
      </div>
      <div className="computer-empty-title">{copy.title}</div>
      {phase === "error" && problem ? (
        <div className="computer-empty-problem">{problem}</div>
      ) : null}
      {copy.hint ? (
        <div className="computer-empty-hint">{copy.hint}</div>
      ) : null}

      {phase === "image_missing" ? (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={actions.prepare}
          disabled={actions.pending}
        >
          Prepare the desktop image
        </button>
      ) : null}
      {phase === "building" ? <BuildProgress runtime={runtime} /> : null}
      {phase === "missing" ? (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={actions.provision}
          disabled={actions.pending}
        >
          {`Create ${name}'s computer`}
        </button>
      ) : null}
      {phase === "asleep" ? (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={actions.start}
          disabled={actions.pending}
        >
          Start
        </button>
      ) : null}
      {phase === "error" ? (
        <div className="computer-empty-actions">
          {problem && /replace it|remove it/i.test(problem) ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={actions.replace}
              disabled={actions.pending}
              data-testid="computer-replace"
            >
              {`Replace ${name}'s computer`}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={actions.provision}
            disabled={actions.pending}
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BuildProgress({ runtime }: { runtime: ComputerRuntime | undefined }) {
  const lines = useAppStore((s) => s.computerRuntimeBuild.lines);
  const tail = lines.slice(-6);
  return (
    <div className="computer-build-log" aria-live="polite">
      {tail.length === 0 ? (
        <div className="computer-build-line">
          {runtime?.imageRef
            ? `Preparing ${runtime.imageRef}…`
            : "Starting the build…"}
        </div>
      ) : (
        // Progress lines repeat legitimately ("Step 3/9"), so occurrence
        // keys keep duplicates stable without leaning on the index alone.
        keyedByOccurrence(tail, (line) => line).map(({ key, value }) => (
          <div key={key} className="computer-build-line">
            {value}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The two ways to get a computer when this machine has no container
 * runtime: install one, or rent a desktop. Shown side by side so cloud
 * reads as a first-class path, not a fallback.
 */
export function RuntimeMissingPaths({
  slug,
  runtime,
}: {
  slug: string;
  runtime: ComputerRuntime | undefined;
}) {
  const queryClient = useQueryClient();
  return (
    <div className="computer-paths" data-testid="computer-runtime-paths">
      <div className="computer-path">
        <div className="computer-path-title">
          <Laptop width={16} height={16} aria-hidden="true" />
          Run it here
        </div>
        <p className="computer-path-body">
          Local computers need Docker. Install OrbStack (lightest on a Mac) or
          Docker Desktop, open it once, then check again. Free, and nothing
          leaves this machine.
          {runtime?.installHint ? ` ${runtime.installHint}` : ""}
        </p>
        <div className="box-account-actions">
          <a
            className="btn btn-primary btn-sm"
            href={ORBSTACK_URL}
            target="_blank"
            rel="noreferrer"
          >
            Install OrbStack
            <OpenNewWindow width={12} height={12} aria-hidden="true" />
          </a>
          <a
            className="btn btn-secondary btn-sm"
            href="https://www.docker.com/products/docker-desktop/"
            target="_blank"
            rel="noreferrer"
          >
            Docker Desktop
            <OpenNewWindow width={12} height={12} aria-hidden="true" />
          </a>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: COMPUTER_RUNTIME_QUERY_KEY,
              })
            }
            data-testid="computer-runtime-check"
          >
            Check again
          </button>
        </div>
        {runtime?.runtimeStartHint ? (
          <p className="computer-path-note">{runtime.runtimeStartHint}</p>
        ) : null}
      </div>
      <div className="computer-path">
        <div className="computer-path-title">
          <Cloud width={16} height={16} aria-hidden="true" />
          Use a cloud computer
        </div>
        <p className="computer-path-body">
          Sign in to ascii.dev or paste a Box key. The desktop lives on a rented
          machine with a persistent disk, so logins survive between turns. You
          pay ascii.dev directly.
        </p>
        <BoxCloudConnect
          compact={true}
          onChanged={() => invalidateAfterBoxChange(queryClient, slug)}
        />
      </div>
    </div>
  );
}

/** After a key is saved or removed, every cloud-dependent query re-reads. */
export function invalidateAfterBoxChange(
  queryClient: QueryClient,
  slug: string,
) {
  void queryClient.invalidateQueries({ queryKey: ["config"] });
  void queryClient.invalidateQueries({ queryKey: COMPUTER_RUNTIME_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: computerQueryKey(slug) });
}

/** Saves `box_api_key` through the normal config route. */
export function BoxKeyField({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const { data: cfg } = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    staleTime: 60_000,
  });
  const keySet = cfg?.box_key_set === true;

  const save = useMutation({
    mutationKey: ["computer-box-key"],
    mutationFn: (key: string) => updateConfig({ box_api_key: key }),
    onSuccess: () => {
      setValue("");
      showNotice("Box key saved", "success");
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void queryClient.invalidateQueries({
        queryKey: COMPUTER_RUNTIME_QUERY_KEY,
      });
      void queryClient.invalidateQueries({ queryKey: computerQueryKey(slug) });
    },
    onError: (err: unknown) => {
      showNotice(
        err instanceof Error ? err.message : "Could not save the Box key",
        "error",
      );
    },
  });

  return (
    <form
      className="computer-box-key"
      onSubmit={(e) => {
        e.preventDefault();
        const key = value.trim();
        if (!key) return;
        save.mutate(key);
      }}
    >
      <input
        type="password"
        className="input computer-box-key-input"
        aria-label="ascii.dev Box API key"
        placeholder={keySet ? "•••••••• (set)" : "box_…"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
      />
      <button
        type="submit"
        className="btn btn-primary btn-sm"
        disabled={save.isPending || value.trim().length === 0}
      >
        {keySet ? "Replace" : "Save"}
      </button>
      <span
        className={`computer-box-key-status${keySet ? " is-set" : ""}`}
        data-testid="box-key-status"
      >
        {keySet ? "Key set" : "No key yet"}
      </span>
    </form>
  );
}
