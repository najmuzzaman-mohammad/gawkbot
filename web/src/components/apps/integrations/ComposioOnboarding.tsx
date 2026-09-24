import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { OpenNewWindow } from "iconoir-react";

import { updateConfig } from "../../../api/client";
import { showNotice } from "../../ui/Toast";
import { ComposioSigninPanel } from "./ComposioSigninPanel";
import { GitHubLogo, GmailLogo, SlackLogo } from "./IntegrationLogos";
import { useComposioSignin } from "./useComposioSignin";

// ComposioOnboarding is the first-run state of the Integrations page when no
// Composio API key is connected. Composio powers the whole integration catalog
// (OAuth, action execution, audit), so without a key there is nothing to
// browse. The primary path is "Sign in with Composio": the broker drives the
// official composio CLI (login → dev init) and stores the project API key
// itself — no copy/paste. The manual key-paste form remains as a collapsed
// fallback for users who prefer pasting a key from the dashboard.

// API keys live in the project settings of the new Composio dashboard; the
// root URL routes signed-in users to their active project.
const COMPOSIO_KEYS_URL = "https://dashboard.composio.dev";

interface ComposioOnboardingProps {
  /** Called after the key is saved so the page can re-fetch config + catalog. */
  onConnected: () => void;
}

export function ComposioOnboarding({ onConnected }: ComposioOnboardingProps) {
  const queryClient = useQueryClient();
  const [showManual, setShowManual] = useState(false);

  const finishConnected = useCallback(async () => {
    showNotice("Integrations connected. Loading…", "success");
    await queryClient.invalidateQueries({ queryKey: ["config"] });
    await queryClient.invalidateQueries({ queryKey: ["integrations"] });
    onConnected();
  }, [queryClient, onConnected]);

  // Stable callback: the hook keys its status-poll effect on it, so a fresh
  // arrow every render would re-run that effect on every render.
  const handleSignedIn = useCallback(() => {
    void finishConnected();
  }, [finishConnected]);
  const signin = useComposioSignin({ onDone: handleSignedIn });

  const connectMutation = useMutation({
    mutationFn: (key: string) => updateConfig({ composio_api_key: key }),
    onSuccess: finishConnected,
    onError: (err: unknown) => {
      showNotice(
        err instanceof Error ? err.message : "Could not save the API key",
        "error",
      );
    },
  });

  return (
    <section className="composio-onb" aria-label="Connect integrations">
      <div className="composio-onb-card">
        <span className="composio-onb-eyebrow">Integrations</span>
        <h2 className="composio-onb-title">Add integrations to your office</h2>
        <p className="composio-onb-lead">
          Connect once to let your agents act in Gmail, Slack, GitHub, and 1200+
          other tools — securely, with OAuth and a full audit trail. We set up
          the rest.
        </p>

        <div className="composio-onb-logos" aria-hidden="true">
          <span className="composio-onb-logo">
            <GmailLogo />
          </span>
          <span className="composio-onb-logo">
            <SlackLogo />
          </span>
          <span className="composio-onb-logo">
            <GitHubLogo />
          </span>
          <span className="composio-onb-more">+250 more</span>
        </div>

        <ComposioSigninPanel
          phase={signin.phase}
          authUrl={signin.authUrl}
          installCommand={signin.installCommand}
          starting={signin.starting}
          onStart={signin.start}
          ctaLabel="Connect integrations"
        />

        {signin.phase === "error" && signin.error ? (
          <p className="composio-onb-error" role="alert">
            {signin.error}
          </p>
        ) : null}

        <button
          type="button"
          className="composio-onb-fallback-toggle"
          aria-expanded={showManual}
          onClick={() => setShowManual((v) => !v)}
        >
          or paste an API key
        </button>

        {showManual ? (
          <ManualKeyForm
            pending={connectMutation.isPending}
            onSubmit={(key) => connectMutation.mutate(key)}
          />
        ) : null}

        <p className="composio-onb-foot">
          Your credentials are stored locally on this workspace and never leave
          it.
        </p>
      </div>
    </section>
  );
}

interface ManualKeyFormProps {
  pending: boolean;
  onSubmit: (key: string) => void;
}

/** Collapsed fallback: paste a project ak_ key from the dashboard. */
function ManualKeyForm({ pending, onSubmit }: ManualKeyFormProps) {
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const trimmed = apiKey.trim();
  const canSubmit = trimmed.length > 0 && !pending;

  return (
    <form
      className="composio-onb-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit(trimmed);
      }}
    >
      <label className="composio-onb-label" htmlFor="composio-api-key">
        API key
      </label>
      <div className="composio-onb-field">
        <input
          id="composio-api-key"
          className="input composio-onb-input"
          type={reveal ? "text" : "password"}
          placeholder="ak_…"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={pending}
        />
        <button
          type="button"
          className="composio-onb-reveal"
          onClick={() => setReveal((v) => !v)}
          aria-pressed={reveal}
        >
          {reveal ? "Hide" : "Show"}
        </button>
      </div>

      <div className="composio-onb-actions">
        <button
          type="submit"
          className="btn composio-onb-submit"
          disabled={!canSubmit}
        >
          {pending ? "Connecting…" : "Save key"}
        </button>
        <a
          className="composio-onb-getkey"
          href={COMPOSIO_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Get an API key
          <OpenNewWindow width={13} height={13} aria-hidden="true" />
        </a>
      </div>
    </form>
  );
}
