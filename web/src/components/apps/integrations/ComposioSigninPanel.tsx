import { OpenNewWindow } from "iconoir-react";

import { CommandRow } from "../../ui/CommandRow";
import type { SigninPhase } from "./useComposioSignin";

// The primary sign-in surface — one panel per flow phase. Shared by the
// first-run onboarding hero and by the sign-in-expired recovery panel, so both
// render the same thing for the same broker state.

export interface ComposioSigninPanelProps {
  phase: SigninPhase;
  authUrl: string;
  installCommand: string;
  starting: boolean;
  onStart: () => void;
  /** Label for the idle-state button: "Connect integrations", "Sign in again". */
  ctaLabel: string;
}

export function ComposioSigninPanel({
  phase,
  authUrl,
  installCommand,
  starting,
  onStart,
  ctaLabel,
}: ComposioSigninPanelProps) {
  if (phase === "installing") {
    return (
      <div className="composio-onb-panel" role="status">
        <p className="composio-onb-panel-title">Setting up integrations…</p>
        <p className="composio-onb-panel-note">
          One-time setup. We’ll open the sign-in page automatically as soon as
          it’s ready.
        </p>
        <p className="composio-onb-wait">Working on it…</p>
      </div>
    );
  }
  if (phase === "cli_missing") {
    return (
      <div className="composio-onb-panel" role="status">
        <p className="composio-onb-panel-title">One quick terminal step</p>
        <p className="composio-onb-panel-note">
          Automatic setup didn’t finish. Run this in a terminal, then try again:
        </p>
        <CommandRow command={installCommand} />
        <div className="composio-onb-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onStart}
            disabled={starting}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (phase === "awaiting_login") {
    return (
      <div className="composio-onb-panel" role="status">
        <p className="composio-onb-panel-title">
          Finish signing in in your browser
        </p>
        {authUrl ? (
          <p className="composio-onb-panel-note">
            We opened the sign-in page in a new tab. If it didn’t appear,{" "}
            <a
              className="composio-onb-getkey"
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              open the sign-in link
              <OpenNewWindow width={13} height={13} aria-hidden="true" />
            </a>
            .
          </p>
        ) : (
          <p className="composio-onb-panel-note">
            Run <code>composio login</code> in a terminal to finish signing in —
            we’ll pick it up automatically.
          </p>
        )}
        <p className="composio-onb-wait">Waiting for you to finish…</p>
      </div>
    );
  }
  if (phase === "provisioning" || phase === "done") {
    return (
      <div className="composio-onb-panel" role="status">
        <p className="composio-onb-panel-title">Connecting your account…</p>
        <p className="composio-onb-panel-note">
          Saving your credentials to this workspace.
        </p>
      </div>
    );
  }
  return (
    <div className="composio-onb-actions">
      <button
        type="button"
        className="btn btn-primary composio-onb-submit"
        onClick={onStart}
        disabled={starting}
      >
        {starting ? "Connecting…" : ctaLabel}
      </button>
    </div>
  );
}
