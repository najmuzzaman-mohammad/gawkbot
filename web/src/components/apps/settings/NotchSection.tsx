import { Field, PageHeader, SettingsGroup } from "./components";
import type { SectionProps } from "./types";

// ─── Notch section ──────────────────────────────────────────────────────

/**
 * One switch for everything a bot does to get noticed without being asked:
 * the notch opening by itself when a bot needs you, a bot peeking out, bots
 * talking among themselves while they wait, and a bot flying in when it
 * starts needing you. Off keeps them inside the notch. The count of what
 * needs you, the faces, and opening the notch by hand are not attention
 * grabs, so they stay.
 *
 * On by default. The notch reads the choice from the broker on its next
 * poll, so it applies within a couple of seconds and needs no restart.
 */
export function NotchSection({ cfg, save }: SectionProps) {
  const jumpOut = cfg.notch_jump_out !== false;

  return (
    <div className="settings-page">
      <PageHeader title="Notch">
        Your bots live in the notch at the top of your screen. When one needs
        you, it comes out to say so.
      </PageHeader>

      <SettingsGroup>
        <Field
          label="Getting your attention"
          hint="Turn this off if it gets in your way. Bots then stay inside the notch: it does not open by itself, nobody peeks out, flies in, or chats while waiting. You still see how many need you, and a click opens it."
        >
          <label className="settings-switch-label">
            <span>Bots jump out of the notch to get your attention</span>
            <input
              type="checkbox"
              className="switch"
              checked={jumpOut}
              onChange={(e) => void save({ notch_jump_out: e.target.checked })}
              data-testid="settings-notch-jump-out-toggle"
            />
          </label>
        </Field>
      </SettingsGroup>
    </div>
  );
}
