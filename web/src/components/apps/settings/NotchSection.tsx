import { Field, PageHeader, SettingsGroup } from "./components";
import type { NotchSectionProps } from "./notchConfig";

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
export function NotchSection({ cfg, save }: NotchSectionProps) {
  const jumpOut = cfg.notch_jump_out !== false;
  const alwaysAllow = cfg.mac_computer_always_allow === true;
  const announce = cfg.notch_announce !== false;

  return (
    <div className="settings-page">
      <PageHeader title="Notch">
        Your bots live in the notch at the top of your screen. When one needs
        you, it comes out to say so.
      </PageHeader>

      <SettingsGroup>
        <Field
          label="Getting your attention"
          hint="Turn this off if it gets in your way. Bots then stay inside the notch: it does not open by itself, nobody peeks out, flies in, or chats while waiting. You still see how many need you, and a click opens it. The same switch hides the working-bot cards at the top right of the screen."
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
        <Field
          label="Speaking up"
          hint="One line out loud, in the Mac's own voice, when a bot needs you or finishes. Never while you are holding the talk key."
        >
          <label className="settings-switch-label">
            <span>Bots say so when they need you or finish</span>
            <input
              type="checkbox"
              className="switch"
              checked={announce}
              onChange={(e) => void save({ notch_announce: e.target.checked })}
              data-testid="settings-notch-announce-toggle"
            />
          </label>
        </Field>
        <Field
          label="Bots on this Mac"
          hint="A bot set to run on this Mac asks you in the notch before its first click or keystroke each turn. Turn this on to let them act without asking; ⌥Esc still stops every bot at once."
        >
          <label className="settings-switch-label">
            <span>Always allow computer use on this Mac</span>
            <input
              type="checkbox"
              className="switch"
              checked={alwaysAllow}
              onChange={(e) =>
                void save({ mac_computer_always_allow: e.target.checked })
              }
              data-testid="settings-mac-always-allow-toggle"
            />
          </label>
        </Field>
      </SettingsGroup>
    </div>
  );
}
