import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, TriangleAlert } from "lucide-react";

import {
  type ConfigSnapshot,
  type ConfigUpdate,
  getConfig,
  getLocalProvidersStatus,
  type LLMRuntimeKind,
  type LocalProviderStatus,
  resetWorkspace,
  shredWorkspace,
  updateConfig,
  type WorkspaceWipeResult,
} from "../../api/client";
import { useOfficeMembers } from "../../hooks/useMembers";
import { router } from "../../lib/router";
import { normalizeProviderList } from "../../lib/runtimeProviders";
import { useAppStore } from "../../stores/app";
import { CredentialRegistrationPanel } from "../cosign";
import { CommandRow } from "../ui/CommandRow";
import {
  ShredCardSubtitle,
  ShredDeletionsList,
  ShredPreservationList,
  ShredWarningCopy,
} from "../ui/ShredWarning";
import { showNotice } from "../ui/Toast";
import { WipeModal } from "../ui/WipeModal";
import { ImageGenSection } from "./SettingsApp.imageGen";
import { BoxAccountSection } from "./settings/BoxAccountSection";
import {
  Field,
  KeyField,
  PageHeader,
  SaveButton,
  Select,
  SettingsGroup,
} from "./settings/components";
import { SECTION_GROUPS } from "./settings/constants";
import { LocalAgentsSection } from "./settings/LocalAgentsSection";
import { NotchSection } from "./settings/NotchSection";
import { PrivacySection } from "./settings/PrivacySection";
import { RuntimeProviderChecklist } from "./settings/RuntimeProviderChecklist";
import type { SectionId, SectionProps } from "./settings/types";

import "../../styles/settings.css";

// ─── Section components ─────────────────────────────────────────────────

// useShredAction wraps `shredWorkspace()` with the cleanup both call sites
// (GeneralSection's inline button and DangerZoneSection's full card) need on
// success: clear the query cache, route the user back to a sensible default
// channel, and reset onboarding state so the wizard reopens. The broker's
// `AfterShred` hook (`internal/team/broker.go`) calls `requestShutdown()`, so
// the page typically re-mounts shortly after — but until it does, the user
// shouldn't be left on a Settings tab whose `cfg` query just got invalidated.
function useShredAction() {
  const queryClient = useQueryClient();
  const resetForOnboarding = useAppStore((s) => s.resetForOnboarding);
  return async (): Promise<boolean> => {
    try {
      const result: WorkspaceWipeResult = await shredWorkspace();
      if (!result.ok) {
        showNotice(result.error || "Shred failed", "error");
        return false;
      }
      queryClient.clear();
      // Home, not the retired #general: post-shred there is no shared room to
      // land in, and onboarding takes over from the home route anyway.
      void router.navigate({ to: "/", replace: true });
      resetForOnboarding();
      showNotice("Workspace shredded. Onboarding reopened.", "success");
      return true;
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "Shred failed", "error");
      return false;
    }
  };
}

// TeamLeadPicker reads the office roster so the human picks from real
// bots rather than typing a slug. The saved value persists as a slug on
// the wire (cfg.team_lead_slug) — the picker round-trips through the slug
// even when the bot's display name later changes, so renaming a bot
// doesn't break the Team Lead binding. Falls back to a free-text input
// while the roster is still loading or empty, so the field is never a
// dead end on a brand-new install.
function TeamLeadPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (slug: string) => void;
}) {
  const { data: members = [], isLoading } = useOfficeMembers();
  if (isLoading || members.length === 0) {
    return (
      <input
        className="settings-input"
        placeholder="e.g. cos"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const knownSlug = members.some((m) => m.slug === value);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— pick a bot —</option>
      {members.map((m) => (
        <option key={m.slug} value={m.slug}>
          {m.name ? `${m.name} (@${m.slug})` : `@${m.slug}`}
        </option>
      ))}
      {value && !knownSlug && (
        <option value={value}>@{value} (not in roster)</option>
      )}
    </Select>
  );
}

function sameProviders(
  a: readonly LLMRuntimeKind[] | null,
  b: readonly LLMRuntimeKind[],
) {
  if (a === null) return false;
  return a.length === b.length && a.every((provider, i) => provider === b[i]);
}

function GeneralSection({ cfg, save }: SectionProps) {
  const initialProviders =
    cfg.llm_provider_priority && cfg.llm_provider_priority.length > 0
      ? cfg.llm_provider_priority
      : cfg.llm_provider
        ? [cfg.llm_provider]
        : [];
  const [providers, setProviders] = useState<string[]>(initialProviders);
  const [teamLead, setTeamLead] = useState(cfg.team_lead_slug ?? "");
  const [maxConcurrent, setMaxConcurrent] = useState(
    cfg.max_concurrent_agents ? String(cfg.max_concurrent_agents) : "",
  );
  const [format, setFormat] = useState(cfg.default_format ?? "text");
  const [timeout, setTimeoutMs] = useState(
    cfg.default_timeout ? String(cfg.default_timeout) : "",
  );
  const [blueprint, setBlueprint] = useState(cfg.blueprint ?? "");
  const [email, setEmail] = useState(cfg.email ?? "");
  const [connectedProviders, setConnectedProviders] = useState<
    LLMRuntimeKind[] | null
  >(null);
  const updateConnectedProviders = useCallback((next: LLMRuntimeKind[]) => {
    setConnectedProviders((prev) => (sameProviders(prev, next) ? prev : next));
  }, []);

  const onSave = async () => {
    const providerPriority =
      connectedProviders ?? normalizeProviderList(providers);
    const patch: ConfigUpdate = {
      llm_provider: providerPriority[0] ?? "",
      llm_provider_priority: providerPriority,
      default_format: format,
      blueprint,
      email,
      team_lead_slug: teamLead,
    };
    if (maxConcurrent)
      patch.max_concurrent_agents = parseInt(maxConcurrent, 10);
    if (timeout) patch.default_timeout = parseInt(timeout, 10);
    await save(patch);
  };

  return (
    <div className="settings-page">
      <PageHeader title="General">
        Core runtime settings. These map to CLI flags and config file entries.
      </PageHeader>

      <RuntimeProviderChecklist
        configuredKinds={cfg.llm_provider_kinds}
        selectedProviders={providers}
        onSelectedProvidersChange={setProviders}
        onConnectedProvidersChange={updateConnectedProviders}
      />

      <SettingsGroup title="Bots">
        <Field label="Team Lead" hint="Bot that leads operations">
          <TeamLeadPicker value={teamLead} onChange={setTeamLead} />
        </Field>
        <Field label="Max Concurrent" hint="Parallel bot limit">
          <input
            className="settings-input"
            type="number"
            min={1}
            placeholder="Unlimited"
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(e.target.value)}
          />
        </Field>
      </SettingsGroup>

      <SettingsGroup title="Defaults">
        <Field label="Output Format" hint="--format">
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="text">Text</option>
            <option value="json">JSON</option>
          </Select>
        </Field>
        <Field label="Timeout (ms)" hint="Default command timeout">
          <input
            className="settings-input"
            type="number"
            min={1000}
            placeholder="120000"
            value={timeout}
            onChange={(e) => setTimeoutMs(e.target.value)}
          />
        </Field>
      </SettingsGroup>

      <SettingsGroup title="Identity">
        <Field label="Blueprint" hint="--blueprint">
          <input
            className="settings-input"
            placeholder="Operation blueprint ID"
            value={blueprint}
            onChange={(e) => setBlueprint(e.target.value)}
          />
        </Field>
        <Field label="Email" hint="Identity scope for integrations">
          <input
            className="settings-input"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
      </SettingsGroup>

      <SaveButton label="Save general settings" onSave={onSave} />

      {cfg.config_path ? (
        <SettingsGroup title="Config file">
          <div className="settings-file-path">{cfg.config_path}</div>
        </SettingsGroup>
      ) : null}
    </div>
  );
}

// ─── Local LLMs section ─────────────────────────────────────────────────

interface LocalProviderMeta {
  kind: string;
  label: string;
  blurb: string;
}

// LOCAL_PROVIDERS lists directly-dispatched local LLM runtimes only. The
// Hermes Bot and OpenClaw Gateway entries that used to live here were
// gateway-controlled — they belong in the Integrations app, not the
// runtime picker, because their job is to import existing bots into the
// team rather than to back a WUPHF-created bot's turns.
const LOCAL_PROVIDERS: LocalProviderMeta[] = [
  {
    kind: "mlx-lm",
    label: "MLX-LM",
    blurb:
      "Apple's MLX-backed inference server. Apple Silicon only. Best fit for native macOS performance.",
  },
  {
    kind: "ollama",
    label: "Ollama",
    blurb:
      "Cross-platform local model runner with the largest model catalog. Works on macOS and Linux.",
  },
  {
    kind: "exo",
    label: "Exo",
    blurb:
      "Distributes inference across multiple devices. Useful when you want to pool a Mac Studio + a laptop.",
  },
];

function detectHostPlatform(): "macos" | "linux" | "windows" | "other" {
  if (typeof navigator === "undefined") return "other";
  const p = navigator.platform.toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.includes("mac") || ua.includes("mac os")) return "macos";
  if (p.includes("linux") || ua.includes("linux")) return "linux";
  if (p.includes("win") || ua.includes("windows")) return "windows";
  return "other";
}

function StatusDot({ status }: { status: LocalProviderStatus | undefined }) {
  let tone = "";
  let title = "Status unknown";
  if (!status) {
    /* default */
  } else if (status.binary_installed && status.reachable) {
    tone = "settings-status-dot--ok";
    title = `Running${status.loaded_model ? ` · ${status.loaded_model}` : ""}`;
  } else if (status.binary_installed) {
    tone = "settings-status-dot--warn";
    title = "Installed but server not reachable — start it from a terminal";
  } else {
    tone = "settings-status-dot--err";
    title = "Not installed";
  }
  return (
    <span
      title={title}
      className={tone ? `settings-status-dot ${tone}` : "settings-status-dot"}
    />
  );
}

interface LocalProviderCardProps {
  meta: LocalProviderMeta;
  status: LocalProviderStatus | undefined;
  cfg: ConfigSnapshot;
  save: (patch: ConfigUpdate) => Promise<void>;
  hostPlatform: ReturnType<typeof detectHostPlatform>;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cognitive complexity is baselined for a focused follow-up refactor.
function LocalProviderCard({
  meta,
  status,
  cfg,
  save,
  hostPlatform,
}: LocalProviderCardProps) {
  // Inputs default to the user's saved override (if any) and otherwise
  // empty so placeholders show the resolved value. We must NOT seed the
  // input with the resolved compile-time default — Save would then
  // persist that default as a permanent override on /config, locking
  // future users out of upstream default changes.
  const initial = cfg.provider_endpoints?.[meta.kind];
  const [baseURL, setBaseURL] = useState(initial?.base_url ?? "");
  const [model, setModel] = useState(initial?.model ?? "");

  // Save is gated on dirty so an empty form (or a form matching the
  // saved override) doesn't write anything. The empty-empty case is
  // also the "clear back to defaults" gesture handled server-side
  // (broker.go:6244) — but only when the user previously had an
  // override; submitting empty-empty against no-override is a no-op
  // and we suppress it.
  const trimmedBaseURL = baseURL.trim();
  const trimmedModel = model.trim();
  const dirty =
    trimmedBaseURL !== (initial?.base_url ?? "") ||
    trimmedModel !== (initial?.model ?? "");

  const onSaveEndpoint = async () => {
    if (!dirty) return;
    await save({
      provider_endpoints: {
        [meta.kind]: { base_url: trimmedBaseURL, model: trimmedModel },
      },
    });
  };

  const onSetDefault = async () => {
    await save({ llm_provider: meta.kind as ConfigUpdate["llm_provider"] });
  };

  const isDefault = cfg.llm_provider === meta.kind;
  // Windows users get the WSL2 banner above; suppressing the install
  // commands here avoids contradicting it (a user reading "use WSL2"
  // shouldn't see a bare `brew install ollama` snippet that won't run
  // in their host shell). They run the linux command inside WSL once
  // they're there.
  const cmdPlatform: "macos" | "linux" | undefined =
    hostPlatform === "macos"
      ? "macos"
      : hostPlatform === "linux"
        ? "linux"
        : undefined;
  const installCmd = cmdPlatform ? status?.install?.[cmdPlatform] : undefined;
  const startCmd = cmdPlatform ? status?.start?.[cmdPlatform] : undefined;
  const notes = status?.notes ?? [];

  return (
    <SettingsGroup data-testid={`local-llm-card-${meta.kind}`}>
      <div className="settings-row settings-row--tall">
        <div className="settings-row-main">
          <div className="settings-row-title">
            <StatusDot status={status} />
            <span>{meta.label}</span>
            {isDefault && (
              <span className="settings-chip settings-chip--accent">
                Default
              </span>
            )}
            {status?.binary_version ? (
              <span className="settings-row-title-muted settings-row-meta--mono">
                {status.binary_version}
              </span>
            ) : null}
          </div>
          <div className="settings-row-meta">{meta.blurb}</div>
          {status?.windows_note ? (
            <div className="settings-row-meta">{status.windows_note}</div>
          ) : null}
        </div>
        {!isDefault && (
          <div className="settings-row-control">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onSetDefault}
              data-testid={`local-llm-set-default-${meta.kind}`}
            >
              Set as default
            </button>
          </div>
        )}
      </div>

      <Field
        label="Base URL"
        hint={`WUPHF_${meta.kind.toUpperCase().replace(/-/g, "_")}_BASE_URL`}
      >
        <input
          className="settings-input"
          placeholder={status?.endpoint ?? "http://127.0.0.1:8080/v1"}
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          data-testid={`local-llm-base-url-${meta.kind}`}
        />
      </Field>
      <Field
        label="Model"
        hint={`WUPHF_${meta.kind.toUpperCase().replace(/-/g, "_")}_MODEL`}
      >
        <input
          className="settings-input"
          placeholder={status?.model ?? ""}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          data-testid={`local-llm-model-${meta.kind}`}
        />
      </Field>
      <SaveButton label="Save endpoint" onSave={onSaveEndpoint} />

      {!status?.binary_installed && installCmd ? (
        <div className="settings-row-sub">
          <div className="settings-row-sub-label">Install</div>
          <CommandRow command={installCmd} />
          {startCmd ? (
            <>
              <div className="settings-row-sub-label">Start</div>
              <CommandRow command={startCmd} />
            </>
          ) : null}
        </div>
      ) : null}
      {status?.binary_installed && !status.reachable && startCmd ? (
        <div className="settings-row-sub">
          <div>
            Installed but the server isn't responding on{" "}
            <code>{status.endpoint}</code>. Start it from a terminal:
          </div>
          <CommandRow command={startCmd} />
        </div>
      ) : null}
      {notes.length > 0 ? (
        <div className="settings-row-sub">
          {notes.map((note) => (
            <p key={note} className="settings-note">
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </SettingsGroup>
  );
}

function LocalLLMsSection({ cfg, save }: SectionProps) {
  const hostPlatform = detectHostPlatform();
  // refetch on the same cadence settings normally do; doctor probes are
  // cheap (~2s worst case for a wedged server) but we don't want to
  // hammer the broker every render.
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["local-providers-status"],
    queryFn: getLocalProvidersStatus,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const byKind = new Map<string, LocalProviderStatus>();
  for (const s of data ?? []) byKind.set(s.kind, s);

  return (
    <div className="settings-page">
      <PageHeader title="Local LLMs">
        Run gawkbot agents through a model on your own machine — no cloud key
        required. Status indicators detect what's installed and what's
        responding; install commands are copy-paste only (we never run shell
        commands for you).
      </PageHeader>

      {hostPlatform === "windows" && (
        <div className="settings-banner">
          <span className="settings-banner-glyph">{"⚠"}</span>
          <div>
            Local LLMs run best on macOS or Linux. Native Windows isn't
            supported; install your runtime inside WSL2 (Ubuntu) and the broker
            will detect it from there.
          </div>
        </div>
      )}

      <div className="settings-group-head">
        <div className="settings-group-title">Available runtimes</div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="local-llms-refresh"
        >
          <RefreshCw size={14} />
          {isFetching ? "Checking…" : "Recheck"}
        </button>
      </div>

      {isLoading ? (
        <div className="app-panel-loading">Detecting installed runtimes…</div>
      ) : null}
      {error ? (
        <p className="settings-error">
          Failed to load status:{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}

      {!(isLoading || error) &&
        LOCAL_PROVIDERS.map((meta) => (
          <LocalProviderCard
            key={meta.kind}
            meta={meta}
            status={byKind.get(meta.kind)}
            cfg={cfg}
            save={save}
            hostPlatform={hostPlatform}
          />
        ))}
    </div>
  );
}

function CompanySection({ cfg, save }: SectionProps) {
  const [name, setName] = useState(cfg.company_name ?? "");
  const [description, setDescription] = useState(cfg.company_description ?? "");
  const [goals, setGoals] = useState(cfg.company_goals ?? "");
  const [size, setSize] = useState(cfg.company_size ?? "");
  const [priority, setPriority] = useState(cfg.company_priority ?? "");

  const onSave = () =>
    save({
      company_name: name,
      company_description: description,
      company_goals: goals,
      company_size: size,
      company_priority: priority,
    });

  return (
    <div className="settings-page">
      <PageHeader title="Company">
        Organizational context injected into agent system prompts. The more you
        fill in, the better agents understand your business.
      </PageHeader>

      <SettingsGroup>
        <Field label="Name" hint="Your company or project name">
          <input
            className="settings-input"
            placeholder="Acme Corp"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field
          label="Description"
          hint="One-liner about the business"
          stacked={true}
        >
          <textarea
            className="settings-input"
            placeholder="What does your company do?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field
          label="Goals"
          hint="What the team is working toward"
          stacked={true}
        >
          <textarea
            className="settings-input"
            placeholder="Current organizational goals"
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
          />
        </Field>

        <Field label="Size" hint="Team or company size">
          <input
            className="settings-input"
            placeholder="e.g. 5, 50, 500"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </Field>

        <Field
          label="Priority"
          hint="What matters most right now"
          stacked={true}
        >
          <textarea
            className="settings-input"
            placeholder="Immediate priority focus"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </Field>
      </SettingsGroup>

      <SaveButton label="Save company info" onSave={onSave} />
    </div>
  );
}

interface KeyDef {
  field: keyof ConfigUpdate;
  flag: keyof ConfigSnapshot;
  label: string;
  placeholder: string;
  env: string;
}

const KEY_DEFS: KeyDef[] = [
  {
    field: "anthropic_api_key",
    flag: "anthropic_key_set",
    label: "Anthropic",
    placeholder: "sk-ant-...",
    env: "ANTHROPIC_API_KEY",
  },
  {
    field: "openai_api_key",
    flag: "openai_key_set",
    label: "OpenAI",
    placeholder: "sk-...",
    env: "OPENAI_API_KEY",
  },
  {
    field: "gemini_api_key",
    flag: "gemini_key_set",
    label: "Gemini",
    placeholder: "AI...",
    env: "GEMINI_API_KEY",
  },
  {
    field: "minimax_api_key",
    flag: "minimax_key_set",
    label: "Minimax",
    placeholder: "mm-...",
    env: "MINIMAX_API_KEY",
  },
  {
    field: "composio_api_key",
    flag: "composio_key_set",
    label: "Composio",
    placeholder: "cmp_...",
    env: "COMPOSIO_API_KEY",
  },
  {
    field: "telegram_bot_token",
    flag: "telegram_token_set",
    label: "Telegram Bot",
    placeholder: "123456:ABC...",
    env: "WUPHF_TELEGRAM_BOT_TOKEN",
  },
];

function KeysSection({ cfg, save }: SectionProps) {
  const [values, setValues] = useState<Record<string, string>>({});

  const onSave = async () => {
    const entries = Object.entries(values).filter(([, v]) => v.trim() !== "");
    if (entries.length === 0) {
      showNotice("No keys entered. Leave blank to keep existing keys.", "info");
      return false;
    }
    const patch: ConfigUpdate = {};
    for (const [k, v] of entries) {
      (patch as Record<string, string>)[k] = v;
    }
    await save(patch);
    setValues({});
  };

  return (
    <div className="settings-page">
      <PageHeader title="API Keys">
        Authentication credentials for external services. Keys are stored in
        your local config file and never transmitted to gawkbot servers. Enter a
        new value to update, or leave blank to keep the current key.
      </PageHeader>

      <BoxAccountSection />

      <SettingsGroup title="Keys">
        {KEY_DEFS.map((def) => (
          <Field key={def.field} label={def.label} hint={`Env: ${def.env}`}>
            <KeyField
              hasValue={Boolean(cfg[def.flag])}
              placeholder={def.placeholder}
              value={values[def.field] ?? ""}
              onChange={(v) =>
                setValues((prev) => ({ ...prev, [def.field]: v }))
              }
            />
          </Field>
        ))}
      </SettingsGroup>

      <SaveButton label="Save API keys" onSave={onSave} />
    </div>
  );
}

function IntegrationsSection({ cfg, save }: SectionProps) {
  const [actionProvider, setActionProvider] = useState<string>("composio");
  const [actionProviderDirty, setActionProviderDirty] = useState(false);

  const onSave = async () => {
    const patch: ConfigUpdate = {};
    if (actionProviderDirty) {
      patch.action_provider = actionProvider as ConfigUpdate["action_provider"];
    }
    await save(patch);
    setActionProviderDirty(false);
  };

  // Gateway-style integrations (OpenClaw, Hermes, Telegram) now live in the
  // dedicated Integrations app. We keep Action Provider + Workspace here
  // because they're install-wide config knobs, not gateways — they configure
  // routing for an existing action surface rather than importing bots.
  return (
    <div className="settings-page">
      <PageHeader title="Integrations">
        Install-wide integration knobs. Connect OpenClaw, Hermes, or Telegram
        from the{" "}
        <button
          type="button"
          className="btn btn-link"
          style={{ padding: 0, height: "auto", fontSize: "inherit" }}
          onClick={() =>
            void router.navigate({
              to: "/apps/$appId",
              params: { appId: "integrations" },
            })
          }
        >
          Integrations app
        </button>
        .
      </PageHeader>

      <SettingsGroup title="Actions">
        <Field label="Action Provider" hint="External action routing">
          <Select
            value={actionProvider}
            onChange={(e) => {
              setActionProvider(e.target.value);
              setActionProviderDirty(true);
            }}
          >
            <option value="composio">Composio</option>
          </Select>
        </Field>
      </SettingsGroup>

      <SettingsGroup title="Workspace">
        <Field label="Workspace ID" hint="Read-only">
          <input
            className="settings-input"
            readOnly={true}
            placeholder="(not set)"
            value={cfg.workspace_id ?? ""}
          />
        </Field>
        <Field label="Workspace Slug" hint="Read-only">
          <input
            className="settings-input"
            readOnly={true}
            placeholder="(not set)"
            value={cfg.workspace_slug ?? ""}
          />
        </Field>
      </SettingsGroup>

      <SettingsGroup title="Approval cosign" padded={true}>
        <CredentialRegistrationPanel />
      </SettingsGroup>

      <SaveButton label="Save integration settings" onSave={onSave} />
    </div>
  );
}

function IntervalsSection({ cfg, save }: SectionProps) {
  const [insights, setInsights] = useState(
    String(cfg.insights_poll_minutes ?? 15),
  );
  const [followUp, setFollowUp] = useState(
    String(cfg.task_follow_up_minutes ?? 60),
  );
  const [reminder, setReminder] = useState(
    String(cfg.task_reminder_minutes ?? 30),
  );
  const [recheck, setRecheck] = useState(
    String(cfg.task_recheck_minutes ?? 15),
  );

  const onSave = () =>
    save({
      insights_poll_minutes: parseInt(insights, 10) || 15,
      task_follow_up_minutes: parseInt(followUp, 10) || 60,
      task_reminder_minutes: parseInt(reminder, 10) || 30,
      task_recheck_minutes: parseInt(recheck, 10) || 15,
    });

  return (
    <div className="settings-page">
      <PageHeader title="Polling Intervals">
        How often background processes check for updates. All values in minutes.
        Minimum 2 minutes.
      </PageHeader>

      <SettingsGroup>
        <Field label="Insights" hint="Context graph polling">
          <input
            className="settings-input"
            type="number"
            min={2}
            placeholder="15"
            value={insights}
            onChange={(e) => setInsights(e.target.value)}
          />
        </Field>
        <Field label="Task Follow-up" hint="Post-completion check-in">
          <input
            className="settings-input"
            type="number"
            min={2}
            placeholder="60"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
          />
        </Field>
        <Field label="Task Reminder" hint="Stalled task nudge">
          <input
            className="settings-input"
            type="number"
            min={2}
            placeholder="30"
            value={reminder}
            onChange={(e) => setReminder(e.target.value)}
          />
        </Field>
        <Field label="Task Recheck" hint="Progress re-evaluation">
          <input
            className="settings-input"
            type="number"
            min={2}
            placeholder="15"
            value={recheck}
            onChange={(e) => setRecheck(e.target.value)}
          />
        </Field>
      </SettingsGroup>

      <SaveButton label="Save intervals" onSave={onSave} />
    </div>
  );
}

const CLI_FLAGS: [string, string][] = [
  ["--provider <name>", "LLM provider (claude-code, codex, opencode)"],
  ["--blueprint <id>", "Operation blueprint for this run"],
  ["--tui", "Launch tmux TUI instead of web UI"],
  ["--web-port <port>", "Web UI port (default: 7891)"],
  ["--broker-port <port>", "Local broker port (default: 7890)"],
  ["--opus-ceo", "Upgrade Chief of Staff bot to Opus model"],
  ["--collab", "Collaborative mode (all bots see all messages)"],
  ["--1o1", "Direct 1:1 session with a single bot"],
  ["--unsafe", "Bypass bot permission checks (dev only)"],
  ["--no-open", "Skip auto-opening browser on launch"],
  ["--from-scratch", "Start without saved blueprint"],
  ["--threads-collapsed", "Start with threads collapsed"],
  ["--cmd <command>", "Run a slash command non-interactively"],
  ["--format <fmt>", "Output format (text, json)"],
  ["--version", "Print version and exit"],
  ["--help-all", "Show all flags including internal ones"],
];

const ENV_VARS: [string, string][] = [
  ["WUPHF_LLM_PROVIDER", "LLM provider override"],
  ["WUPHF_BROKER_PORT", "Broker port"],
  ["WUPHF_CONFIG_PATH", "Config file path override"],
  ["WUPHF_RUNTIME_HOME", "Runtime state directory"],
  ["WUPHF_START_FROM_SCRATCH", "Start without blueprint (1)"],
  ["WUPHF_ONE_ON_ONE", "Enable 1:1 mode (1)"],
  ["WUPHF_HEADLESS_PROVIDER", "Headless provider override"],
  ["WUPHF_INSIGHTS_INTERVAL_MINUTES", "Insights poll interval"],
  ["WUPHF_TASK_FOLLOWUP_MINUTES", "Task follow-up interval"],
  ["WUPHF_TASK_REMINDER_MINUTES", "Task reminder interval"],
  ["WUPHF_TASK_RECHECK_MINUTES", "Task recheck interval"],
];

function FlagsSection() {
  return (
    <div className="settings-page">
      <PageHeader title="CLI Flags">
        All flags available when launching gawkbot from the terminal. These are
        runtime-only and not persisted in the config file.
      </PageHeader>

      <SettingsGroup title="Flags">
        <table className="settings-table">
          <thead>
            <tr>
              <th>Flag</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {CLI_FLAGS.map(([flag, desc]) => (
              <tr key={flag}>
                <td className="settings-table-code">{flag}</td>
                <td>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsGroup>

      <SettingsGroup title="Environment Variables">
        <div className="settings-row-sub">
          Settings resolve in order: CLI flag → environment variable → config
          file → default. Set these in your shell profile to override config
          file values.
        </div>
        <table className="settings-table">
          <thead>
            <tr>
              <th>Variable</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            {ENV_VARS.map(([v, p]) => (
              <tr key={v}>
                <td className="settings-table-code">{v}</td>
                <td>{p}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsGroup>
    </div>
  );
}

// ─── Danger Zone ────────────────────────────────────────────────────────

type DangerAction = "reset" | "shred";

function DangerZoneSection() {
  const [open, setOpen] = useState<DangerAction | null>(null);
  const [busy, setBusy] = useState(false);
  const shred = useShredAction();

  const handleReset = async () => {
    setBusy(true);
    try {
      const result: WorkspaceWipeResult = await resetWorkspace();
      if (!result.ok) {
        showNotice(result.error || "Reset failed", "error");
        setBusy(false);
        return;
      }
      showNotice("Broker state cleared. Reloading…", "success");
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "Reset failed", "error");
      setBusy(false);
    }
  };

  const handleShred = async () => {
    setBusy(true);
    try {
      // Leave the modal mounted on failure so the user can retry without
      // having to reopen the Danger Zone and re-type the confirm phrase.
      // useShredAction surfaces the failure toast and never throws.
      const ok = await shred();
      if (ok) setOpen(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-page">
      <PageHeader title="Danger Zone">
        Irreversible operations on this workspace. Reset reloads the current
        broker. Shred wipes local workspace history and reopens onboarding in
        the running web UI.
      </PageHeader>

      <SettingsGroup title="Irreversible">
        {/* RESET — narrow: broker runtime state only */}
        <div className="settings-row settings-row--tall">
          <div className="settings-row-main">
            <div className="settings-row-title">
              <RefreshCw size={16} />
              <span>Reset broker state</span>
            </div>
            <div className="settings-row-meta">
              Use this when something is stuck — an agent wedged, the queue
              won't drain, messages stop flowing — and you want a clean restart
              without losing your team or work.
            </div>
            <div className="settings-list-label">Clears</div>
            <ul className="settings-list">
              <li>
                Broker runtime state (
                <code>~/.wuphf/team/broker-state.json</code>)
              </li>
              <li>Last-good in-memory snapshot</li>
            </ul>
            <div className="settings-list-label">Preserved</div>
            <ul className="settings-list">
              <li>Your team roster, company identity, tasks, workflows</li>
              <li>All on-disk history (logs, sessions, artifacts)</li>
              <li>API keys and config</li>
            </ul>
          </div>
          <div className="settings-row-control">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setOpen("reset")}
              disabled={busy}
            >
              Reset broker state…
            </button>
          </div>
        </div>

        {/* SHRED — full wipe */}
        <div className="settings-row settings-row--tall settings-row--danger">
          <div className="settings-row-main">
            <div className="settings-row-title">
              <TriangleAlert size={16} />
              <span>Shred workspace</span>
            </div>
            <div className="settings-row-meta">
              <ShredCardSubtitle />
            </div>
            <div className="settings-list-label">Deletes</div>
            <ul className="settings-list">
              <ShredDeletionsList />
            </ul>
            <div className="settings-list-label">Preserved</div>
            <ul className="settings-list">
              <ShredPreservationList />
            </ul>
          </div>
          <div className="settings-row-control">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setOpen("shred")}
              disabled={busy}
            >
              Shred workspace…
            </button>
          </div>
        </div>
      </SettingsGroup>

      {open === "reset" && (
        <WipeModal
          title="Reset broker state?"
          severity="warn"
          intro={
            <>
              This clears the broker's on-disk runtime state and reboots the
              office from a clean slate. Your team, company, tasks, and
              workflows are all kept. If this doesn't unblock things, try{" "}
              <strong>Shred workspace</strong> instead.
            </>
          }
          confirmLabel="Reset broker state"
          busy={busy}
          onConfirm={handleReset}
          onCancel={() => setOpen(null)}
        />
      )}

      {open === "shred" && (
        <WipeModal
          title="Shred this workspace?"
          severity="critical"
          intro={<ShredWarningCopy />}
          confirmLabel="Shred workspace"
          busy={busy}
          onConfirm={handleShred}
          onCancel={() => setOpen(null)}
        />
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────

// One section is mounted at a time; the nav picks which. A switch rather
// than a chain of `section === x &&` so adding a section stays a one-line
// change here and the shell component stays simple.
function SectionBody({
  section,
  cfg,
  save,
}: { section: SectionId } & SectionProps) {
  switch (section) {
    case "general":
      return <GeneralSection cfg={cfg} save={save} />;
    case "agents":
      return <LocalAgentsSection />;
    case "notch":
      return <NotchSection cfg={cfg} save={save} />;
    case "local-llms":
      return <LocalLLMsSection cfg={cfg} save={save} />;
    case "image-gen":
      return <ImageGenSection />;
    case "company":
      return <CompanySection cfg={cfg} save={save} />;
    case "keys":
      return <KeysSection cfg={cfg} save={save} />;
    case "integrations":
      return <IntegrationsSection cfg={cfg} save={save} />;
    case "intervals":
      return <IntervalsSection cfg={cfg} save={save} />;
    case "flags":
      return <FlagsSection />;
    case "privacy":
      return <PrivacySection cfg={cfg} save={save} />;
    case "danger":
      return <DangerZoneSection />;
  }
}

export function SettingsApp() {
  const [section, setSection] = useState<SectionId>("general");
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    staleTime: 10_000,
  });

  const saveMutation = useMutation({
    mutationFn: (patch: ConfigUpdate) => updateConfig(patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      showNotice("Settings saved.", "success");
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Failed to save settings";
      showNotice(message, "error");
    },
  });

  // Reset section state when data changes so form values pick up latest server state
  const [dataKey, setDataKey] = useState(0);
  useEffect(() => {
    setDataKey((k) => k + 1);
  }, []);

  const save = async (patch: ConfigUpdate) => {
    await saveMutation.mutateAsync(patch);
  };

  if (isLoading) {
    return <div className="app-panel-loading">Loading settings...</div>;
  }

  if (error || !data) {
    return (
      <div className="app-panel-loading">
        Failed to load settings:{" "}
        {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }

  return (
    <div className="settings-app">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTION_GROUPS.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <p className="settings-nav-group-label">{group.label}</p>
            {group.items.map((sec) => {
              const { Icon } = sec;
              return (
                <button
                  type="button"
                  key={sec.id}
                  className={
                    sec.id === section
                      ? "settings-nav-item is-active"
                      : "settings-nav-item"
                  }
                  aria-current={sec.id === section ? "page" : undefined}
                  onClick={() => setSection(sec.id)}
                  // testid so e2e can disambiguate the Settings section
                  // buttons from buttons with the same name that live in
                  // the parent sidebar (e.g. the Integrations sidebar app
                  // entry shares the "Integrations" accessible name with
                  // the Settings → Integrations section button).
                  data-testid={`settings-nav-${sec.id}`}
                >
                  <Icon className="settings-nav-icon" />
                  <span>{sec.name}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="settings-body" key={dataKey}>
        <SectionBody section={section} cfg={data} save={save} />
      </div>
    </div>
  );
}
