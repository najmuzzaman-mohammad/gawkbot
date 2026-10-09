import { setAnalyticsConsent, track } from "../../../lib/analytics";
import { Field, PageHeader, SettingsGroup } from "./components";
import type { SectionProps } from "./types";

// ─── Privacy & Analytics section ────────────────────────────────────────

/**
 * Two independent consent toggles for product analytics. Both default ON and
 * apply live (no reload): a flip stops/starts capture or recording immediately
 * and persists to config. Honest copy states plainly that analytics never
 * collects content and that recordings mask everything you type (PostHog's
 * default input masking). See docs/specs/product-analytics.md.
 */
export function PrivacySection({ cfg, save }: SectionProps) {
  const telemetry = cfg.analytics_telemetry_enabled !== false;
  const recording = cfg.analytics_session_recording_enabled !== false;
  // The toggles only do something when analytics is actually configured (a
  // PostHog key resolved at build time or injected by the operator).
  const configured = cfg.analytics_configured === true;

  const setTelemetry = (enabled: boolean) => {
    // Apply live first so an opt-out takes effect before the consent event;
    // that keeps us from sending a tracking event the instant someone opts out.
    setAnalyticsConsent({ telemetry: enabled });
    track("analytics_consent_set", {
      channel: "telemetry",
      enabled,
      surface: "settings",
    });
    void save({ analytics_telemetry_enabled: enabled });
  };
  const setRecording = (enabled: boolean) => {
    setAnalyticsConsent({ recording: enabled });
    track("analytics_consent_set", {
      channel: "recording",
      enabled,
      surface: "settings",
    });
    void save({ analytics_session_recording_enabled: enabled });
  };

  return (
    <div className="settings-page">
      <PageHeader title="Privacy & Analytics">
        Two independent, optional controls, both on by default. Product
        analytics never collects your content, and session recordings mask
        everything you type — passwords, keys, and form fields. Changes take
        effect immediately.
      </PageHeader>

      <SettingsGroup>
        <Field
          label="Product analytics"
          hint="Anonymous usage events — counts and shapes of what you do, never the content. Used to understand which flows work and which need help."
        >
          <label className="settings-switch-label">
            <span>Share anonymous product analytics</span>
            <input
              type="checkbox"
              className="switch"
              checked={telemetry}
              onChange={(e) => setTelemetry(e.target.checked)}
              data-testid="settings-telemetry-toggle"
            />
          </label>
        </Field>

        <Field
          label="Session recording"
          hint="Replays that mask everything you type — passwords, keys, and form fields — while capturing layout, clicks, and navigation to fix rough edges."
        >
          <label className="settings-switch-label">
            <span>Allow session recordings (typed text masked)</span>
            <input
              type="checkbox"
              className="switch"
              checked={recording}
              onChange={(e) => setRecording(e.target.checked)}
              data-testid="settings-recording-toggle"
            />
          </label>
        </Field>
      </SettingsGroup>

      {configured ? null : (
        <p className="settings-page-desc">
          Analytics is not configured on this install, so these settings have no
          effect until an operator sets a PostHog key (WUPHF_POSTHOG_KEY). Your
          choices are still saved.
        </p>
      )}
    </div>
  );
}
