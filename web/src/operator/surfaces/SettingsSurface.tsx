// Settings — kept deliberately small, and HONEST: every control on this
// surface is real. Voice persists to the broker config. The earlier mock
// groups — a digest toggle, a delivery input, an approvals toggle, a dead
// Delete-workspace button, a no-op "Let wuphf host voice" toggle, and a
// read-only Runtime group promising a roadmap — presented non-functional
// controls as real and were removed in the 2026-08 QA passes. The engine
// identity now rides as one line under Usage instead of a dead group.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type ConfigStatus, get, getConfig, post } from "../../api/client";
import { getUsage } from "../../api/platform";
import { openProviderSwitcher } from "../../components/ui/ProviderSwitcher";
import { Eyebrow, SurfaceHeader } from "../components/primitives";

/** 4.6M / 227k style token formatting for the usage readout. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function SettingsSurface() {
  // The Voice group persists to the broker config so the real call can mint
  // ephemeral Realtime tokens from the key. The key itself is write-only: we
  // never read it back, only whether one is set.
  const qc = useQueryClient();
  const config = useQuery({
    queryKey: ["operator-config"],
    queryFn: () => get<ConfigStatus>("/config"),
  });
  const keySet = Boolean(config.data?.openai_key_set);
  // Live usage — the cost readout the retired office shell used to own. The
  // operator is the only front door now, so what the agents spend must be
  // visible here.
  const usage = useQuery({
    queryKey: ["operator-usage"],
    queryFn: () => getUsage().catch(() => null),
    refetchInterval: 30_000,
    retry: false,
  });
  // Full config snapshot for the read-only Runtime readout.
  // Shares the office-era ["config"] key: the provider switcher invalidates
  // it after a switch, so the engine label refreshes without extra wiring.
  const snapshot = useQuery({
    queryKey: ["config"],
    queryFn: () => getConfig().catch(() => null),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const [keyInput, setKeyInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const save = useMutation({
    mutationFn: (body: { openai_api_key?: string; realtime_model?: string }) =>
      post("/config", body),
    onSuccess: () => {
      setKeyInput("");
      qc.invalidateQueries({ queryKey: ["operator-config"] });
    },
  });
  // Humanized engine identity (one line, not a settings group): raw provider
  // slugs stay out of the UI.
  const RUNTIME_LABELS: Record<string, string> = {
    "claude-code": "Claude",
    claude: "Claude",
    anthropic: "Claude",
    openai: "OpenAI",
    codex: "OpenAI Codex",
    ollama: "a local open-weight model (Ollama)",
  };
  const rawProvider = snapshot.data?.llm_provider ?? "";
  const runtimeLabel = rawProvider
    ? (RUNTIME_LABELS[rawProvider] ?? rawProvider)
    : null;
  const saveError = save.isError
    ? save.error instanceof Error
      ? save.error.message
      : "Could not save voice settings. Check the key and try again."
    : null;

  return (
    <div className="opr-surface-wide">
      <SurfaceHeader
        eyebrow="Settings"
        title="Settings"
        lede="Voice, usage, and your workspace. Everything else your AI handles."
      />

      <div className="opr-settings">
        <div className="opr-set-group">
          <Eyebrow>Voice</Eyebrow>
          <div className="opr-set-row">
            <div>
              <div className="opr-set-label">
                OpenAI Realtime key
                {keySet ? (
                  <span className="opr-pill opr-pill-good opr-set-pill">
                    Connected
                  </span>
                ) : null}
              </div>
              <div className="opr-set-help">
                Powers the real screen-share call where you build tools by
                talking. Your key stays in your workspace and is never sent to
                the browser. With no key, the call is a scripted example.
              </div>
            </div>
            <input
              className="opr-input"
              type="password"
              aria-label="OpenAI Realtime key"
              placeholder={keySet ? "•••• stored — paste to replace" : "sk-..."}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
          </div>
          <div className="opr-set-row">
            <div>
              <div className="opr-set-label">Realtime model</div>
              <div className="opr-set-help">
                The OpenAI Realtime model the call uses. Leave as the default
                unless your account needs a different one.
              </div>
            </div>
            <input
              className="opr-input"
              aria-label="Realtime model"
              placeholder={config.data?.realtime_model || "gpt-realtime-2"}
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
            />
          </div>
          <div className="opr-set-row" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="opr-btn opr-btn-primary opr-btn-sm"
              disabled={save.isPending || !(keyInput || modelInput)}
              onClick={() =>
                save.mutate({
                  ...(keyInput ? { openai_api_key: keyInput } : {}),
                  ...(modelInput ? { realtime_model: modelInput } : {}),
                })
              }
            >
              {save.isPending ? "Saving…" : "Save voice settings"}
            </button>
          </div>
          {saveError ? (
            <div className="opr-set-row" role="alert">
              <div className="opr-set-help opr-danger">{saveError}</div>
            </div>
          ) : null}
        </div>

        <div className="opr-set-group">
          <Eyebrow>Usage</Eyebrow>
          <div className="opr-set-row">
            <div>
              <div className="opr-set-label">What your agents have spent</div>
              <div className="opr-set-help">
                All-time inference on this workspace, on your account. Builds
                and routine runs both land here.
              </div>
            </div>
            <span className="opr-usage-readout">
              {usage.data?.total
                ? `$${usage.data.total.cost_usd.toFixed(2)} · ${formatTokens(
                    usage.data.total.total_tokens,
                  )} tokens · ${usage.data.total.requests} runs`
                : "no spend recorded yet"}
            </span>
          </div>
          {runtimeLabel ? (
            <div className="opr-set-row">
              <div>
                <div className="opr-set-label">Engine</div>
                <div className="opr-set-help">
                  Your agents run on {runtimeLabel}. Switching restarts them on
                  the new engine.
                </div>
              </div>
              <button
                type="button"
                className="opr-btn opr-btn-sm"
                onClick={openProviderSwitcher}
              >
                Change engine
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
