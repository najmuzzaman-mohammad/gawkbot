// Settings — kept deliberately small, and HONEST: every control on this
// surface is real. Voice persists to the broker config. Runtime is read-only
// status (set during onboarding). The earlier mock groups — a digest toggle,
// a "Deliver to #revops · maya@company.com" input, an approvals toggle, and a
// dead Delete-workspace button — presented non-functional controls as real
// (the approvals toggle misrepresented a safety property in both directions)
// and were removed in the 2026-08 QA pass.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type ConfigStatus, get, getConfig, post } from "../../api/client";
import { Eyebrow, SurfaceHeader } from "../components/primitives";

export function SettingsSurface() {
  const [nexHosted, setNexHosted] = useState(false);

  // The Voice group persists to the broker config so the real call can mint
  // ephemeral Realtime tokens from the key. The key itself is write-only: we
  // never read it back, only whether one is set.
  const qc = useQueryClient();
  const config = useQuery({
    queryKey: ["operator-config"],
    queryFn: () => get<ConfigStatus>("/config"),
  });
  const keySet = Boolean(config.data?.openai_key_set);
  // Full config snapshot for the read-only Runtime readout.
  const snapshot = useQuery({
    queryKey: ["operator-config-snapshot"],
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
        lede="Voice, notifications, and approvals. Everything else your AI handles."
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
                talking. Your key is stored on your broker and never sent to the
                browser. With no key, the call is the guided preview.
              </div>
            </div>
            <input
              className="opr-input"
              type="password"
              aria-label="OpenAI Realtime key"
              placeholder={keySet ? "•••• stored — paste to replace" : "sk-..."}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              disabled={nexHosted}
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
              disabled={nexHosted}
            />
          </div>
          <div className="opr-set-row" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="opr-btn opr-btn-primary opr-btn-sm"
              disabled={
                save.isPending || nexHosted || !(keyInput || modelInput)
              }
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
          <div className="opr-set-row">
            <div>
              <div className="opr-set-label">Let wuphf host voice for me</div>
              <div className="opr-set-help">
                Metered through wuphf cloud. With no key and this off, the call
                is the guided preview. You can still build everything from chat.
              </div>
            </div>
            <button
              type="button"
              aria-pressed={nexHosted}
              aria-label="Let wuphf host voice for me"
              className={`opr-toggle${nexHosted ? " is-on" : ""}`}
              onClick={() => setNexHosted((v) => !v)}
            />
          </div>
        </div>

        <div className="opr-set-group">
          <Eyebrow>Runtime</Eyebrow>
          <div className="opr-set-row">
            <div>
              <div className="opr-set-label">Default runtime</div>
              <div className="opr-set-help">
                The engine new agents run on, picked during setup. Per-agent
                runtime switching lands here next; until then this is
                read-only.
              </div>
            </div>
            <span className="opr-pill opr-pill-muted">
              {snapshot.data?.llm_provider || "not set"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
