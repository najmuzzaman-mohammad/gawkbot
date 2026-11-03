import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getConfig, updateConfig } from "../api/client";
import type {
  NotchConfigSnapshot,
  NotchConfigUpdate,
} from "../components/apps/settings/notchConfig";
import { requestPermission } from "./api";
import { SHORTCUTS } from "./keys";
import type { NotchState } from "./types";

/** The voices the office can answer in (internal/team/broker_realtime_notch.go). */
export const VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

export interface NotchSettingsProps {
  state: NotchState;
  onBack: () => void;
  /** Opens the full view at a path, for what the notch does not hold. */
  onOpen: (path: string) => void;
}

export const CONFIG_QUERY_KEY = ["notch-config"] as const;

/** The settings pages, in the order the nav lists them. */
export const SETTINGS_PAGES = [
  ["attention", "Attention"],
  ["ideas", "Suggestions"],
  ["voice", "Voice"],
  ["mac", "This Mac"],
  ["shortcuts", "Shortcuts"],
] as const;

type PageId = (typeof SETTINGS_PAGES)[number][0];

interface SwitchRowProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  testId: string;
}

function SwitchRow({ label, hint, checked, onChange, testId }: SwitchRowProps) {
  return (
    <label className="nset-row">
      <span className="nset-text">
        <b>{label}</b>
        <small>{hint}</small>
      </span>
      <input
        type="checkbox"
        className="nset-switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
    </label>
  );
}

/**
 * The notch's own settings: how it gets your attention, how it speaks,
 * which voice answers, and what the app may do on this Mac. Each switch
 * saves on its own through the same config the full app uses; the rest
 * of settings (providers, integrations, bots) stays in the full view.
 */
export function NotchSettings({ state, onBack, onOpen }: NotchSettingsProps) {
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: getConfig,
    staleTime: 5_000,
  });
  const cfg = (config.data ?? {}) as NotchConfigSnapshot & {
    realtime_voice?: string;
    openai_key_set?: boolean;
  };
  const save = useMutation({
    mutationFn: (patch: NotchConfigUpdate & { realtime_voice?: string }) =>
      updateConfig(patch),
    onMutate: (patch) => {
      queryClient.setQueryData(CONFIG_QUERY_KEY, (c: object | undefined) => ({
        ...(c ?? {}),
        ...patch,
      }));
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY }),
  });
  const [page, setPage] = useState<PageId>("attention");
  const scroller = useRef<HTMLDivElement>(null);
  const go = (id: PageId) => {
    setPage(id);
    scroller.current
      ?.querySelector(`[data-page="${id}"]`)
      ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };
  const perms = state.permissions;
  const caps = state.capabilities;
  const inApp = !!caps;
  return (
    <div className="npanel nsettings" data-testid="notch-settings">
      <div className="nset-head">
        <button
          type="button"
          className="nicon"
          aria-label="Back"
          title="Back (Esc)"
          onClick={onBack}
        >
          ‹
        </button>
        <span className="nset-title">
          <b>Settings</b>
          <small>The notch. Everything else is in the full view.</small>
        </span>
        <button
          type="button"
          className="nbtn is-quiet"
          onClick={() => onOpen("/apps/settings")}
        >
          All settings ↗
        </button>
      </div>
      <div className="nset-layout">
        <nav className="nset-nav" aria-label="Settings pages">
          {SETTINGS_PAGES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`nset-nav-item${page === id ? " is-on" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => go(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="nscroll" ref={scroller}>
          <section
            className="nset-group"
            data-page="attention"
            aria-label="Attention"
          >
            <h3 className="nsection">Attention</h3>
            <SwitchRow
              label="Cards at the top right"
              hint="A card for each bot at work, waiting on you, or just done, with its whole line. Off, the notch only shows a count."
              checked={cfg.notch_jump_out !== false}
              onChange={(on) => save.mutate({ notch_jump_out: on })}
              testId="nset-jump-out"
            />
            <SwitchRow
              label="Bots say so out loud when they need you or finish"
              hint="One line in the Mac's own voice. Never while you are holding the talk key."
              checked={cfg.notch_announce !== false}
              onChange={(on) => save.mutate({ notch_announce: on })}
              testId="nset-announce"
            />
          </section>
          <section className="nset-group" data-page="ideas" aria-label="Ideas">
            <h3 className="nsection">Suggestions</h3>
            <SwitchRow
              label="Look for bots worth having, once a day"
              hint="Reads titles and subjects across the integrations you connected, never bodies, and proposes bots in the notch. Nothing is created without your yes."
              checked={cfg.notch_ideas !== false}
              onChange={(on) => save.mutate({ notch_ideas: on })}
              testId="nset-ideas"
            />
            <label className="nset-row">
              <span className="nset-text">
                <b>At</b>
                <small>
                  The local hour the look runs; caught up after sleep.
                </small>
              </span>
              <select
                className="nset-select"
                value={String(cfg.notch_ideas_hour ?? 9)}
                onChange={(e) =>
                  save.mutate({ notch_ideas_hour: Number(e.target.value) })
                }
                data-testid="nset-ideas-hour"
                disabled={cfg.notch_ideas === false}
              >
                {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </select>
            </label>
          </section>
          <section className="nset-group" data-page="voice" aria-label="Voice">
            <h3 className="nsection">Voice</h3>
            <label className="nset-row">
              <span className="nset-text">
                <b>The office answers in</b>
                <small>
                  {cfg.openai_key_set
                    ? "Hold V with no reply box open to talk; it answers out loud."
                    : "Needs an OpenAI key in the full view; until then V dictates into the reply box."}
                </small>
              </span>
              <select
                className="nset-select"
                value={
                  VOICES.includes(
                    (cfg.realtime_voice ?? "") as (typeof VOICES)[number],
                  )
                    ? cfg.realtime_voice
                    : "marin"
                }
                onChange={(e) =>
                  save.mutate({ realtime_voice: e.target.value })
                }
                data-testid="nset-voice"
                disabled={!cfg.openai_key_set}
              >
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v[0].toUpperCase() + v.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </section>
          <section className="nset-group" data-page="mac" aria-label="This Mac">
            <h3 className="nsection">This Mac</h3>
            <SwitchRow
              label="Always allow computer use on this Mac"
              hint="Off, a bot set to run on this Mac asks before its first click each turn. ⌥Esc stops every bot either way."
              checked={cfg.mac_computer_always_allow === true}
              onChange={(on) => save.mutate({ mac_computer_always_allow: on })}
              testId="nset-always-allow"
            />
            {inApp ? (
              <div className="nset-row" data-testid="nset-grants">
                <span className="nset-text">
                  <b>What the app may do</b>
                  <small>
                    {perms?.accessibility
                      ? "Accessibility granted"
                      : "Accessibility not granted"}{" "}
                    ·{" "}
                    {perms?.screen_recording
                      ? "Screen Recording granted"
                      : "Screen Recording not granted"}
                  </small>
                </span>
                <span className="nset-actions">
                  {perms?.accessibility ? null : (
                    <button
                      type="button"
                      className="nbtn is-quiet"
                      onClick={() => void requestPermission("accessibility")}
                    >
                      Allow Accessibility
                    </button>
                  )}
                  {perms?.screen_recording ? null : (
                    <button
                      type="button"
                      className="nbtn is-quiet"
                      onClick={() => void requestPermission("screen_recording")}
                    >
                      Allow Screen Recording
                    </button>
                  )}
                </span>
              </div>
            ) : (
              <p className="nset-note">
                Open gawkbot as an app for the pointer, the screen, and bots on
                this Mac.
              </p>
            )}
          </section>
          <section
            className="nset-group"
            data-page="shortcuts"
            aria-label="Shortcuts"
          >
            <h3 className="nsection">Shortcuts</h3>
            <dl className="nset-keys">
              {SHORTCUTS.map(([key, what]) => (
                <div key={key}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
