// "Runs on": where this bot's computer lives. Segmented picker that writes
// the member's `computer` field through the office-members update action.
import type { ComputerMemberSetting } from "../../../api/computer";
import { RUNS_ON_OPTIONS } from "./computerPhase";

interface ComputerRunsOnProps {
  /** The member's saved setting; "" means auto. */
  setting: ComputerMemberSetting;
  /** What auto resolved to, from the status. Highlights the auto choice. */
  effective: "off" | "sandbox" | "cloud" | undefined;
  pending: boolean;
  onChange: (next: ComputerMemberSetting) => void;
}

export function ComputerRunsOn({
  setting,
  effective,
  pending,
  onChange,
}: ComputerRunsOnProps) {
  const selected = setting || effective;
  return (
    <section className="computer-card computer-runs-on" aria-label="Runs on">
      <div className="computer-card-title">Runs on</div>
      <p className="computer-card-text computer-card-text--secondary">
        {setting === ""
          ? "Auto picks a Local VM when a container runtime is installed, otherwise the computer stays off. "
          : ""}
        Pick where this bot's computer lives. <b>Local VM</b> is a
        Cua-controlled Linux desktop in a container on this machine, free and
        separate from your own desktop. <b>Cloud</b> rents a desktop from
        ascii.dev Box with your key.
      </p>
      <fieldset className="computer-segmented" disabled={pending}>
        <legend className="sr-only">Where this bot's computer runs</legend>
        {RUNS_ON_OPTIONS.map((opt) => {
          const isSelected = selected === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              className={`computer-segment${isSelected ? " is-selected" : ""}`}
              aria-pressed={isSelected}
              onClick={() => {
                if (setting === opt.value) return;
                onChange(opt.value);
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </fieldset>
    </section>
  );
}
