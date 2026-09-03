// Who is driving. The person can take the wheel or hand it back; the bot
// can only ask. While the person holds it, the bot's clicks and keystrokes
// are refused, not queued, so the copy says exactly that.
import { HalfMoon, Trash } from "iconoir-react";

import { confirm } from "../../ui/ConfirmDialog";

interface ComputerDrivingProps {
  name: string;
  held: boolean;
  helpReason: string | null;
  /** True when the bot is mid-turn; deleting the computer waits for it. */
  busy: boolean;
  destination: "off" | "sandbox" | "cloud" | undefined;
  pending: boolean;
  onTakeControl: () => void;
  onHandBack: () => void;
  onDismissHelp: () => void;
  onSleep: () => void;
  onRemove: () => void;
}

function HandGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M11 11.5V4.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M14 12V6.5a1.5 1.5 0 0 1 3 0V13" />
      <path d="M17 13v-1.5a1.5 1.5 0 0 1 3 0V16a6 6 0 0 1-6 6h-2a6 6 0 0 1-5.2-3L4 14.5a1.6 1.6 0 0 1 2.6-1.8L8 14.5" />
    </svg>
  );
}

export function ComputerDriving({
  name,
  held,
  helpReason,
  busy,
  destination,
  pending,
  onTakeControl,
  onHandBack,
  onDismissHelp,
  onSleep,
  onRemove,
}: ComputerDrivingProps) {
  const askRemove = () => {
    confirm({
      title: "Delete this bot's computer",
      message: `Delete ${name}'s computer? Its workspace folder stays on disk; the desktop, open apps, and browser profile are gone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: onRemove,
    });
  };

  return (
    <div className="computer-driving">
      {helpReason && !held ? (
        <div
          className="computer-card computer-card--help"
          role="status"
          data-testid="computer-help-card"
        >
          <div className="computer-card-text">
            <b>{name}</b> asked for your hands: {helpReason}
          </div>
          <div className="computer-card-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onTakeControl}
              disabled={pending}
            >
              <HandGlyph />
              Take control
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onDismissHelp}
              disabled={pending}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {held ? (
        <div
          className="computer-card computer-card--held"
          role="status"
          data-testid="computer-held-card"
        >
          <div className="computer-card-text">
            You have the wheel — the bot's clicks and keystrokes are refused
            until you hand it back.
          </div>
          <div className="computer-card-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onHandBack}
              disabled={pending}
            >
              <HandGlyph />
              Hand control back
            </button>
          </div>
        </div>
      ) : null}

      <div className="computer-actions">
        {!(held || helpReason) ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onTakeControl}
            disabled={pending}
            title="Pause the bot's hands and drive this computer yourself"
          >
            <HandGlyph />
            Take control
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onSleep}
          disabled={pending}
          title="Put the computer to sleep"
        >
          <HalfMoon width={14} height={14} aria-hidden="true" />
          Sleep
        </button>
        {destination === "sandbox" ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm computer-btn-danger"
            onClick={askRemove}
            disabled={pending || busy}
            title={
              busy
                ? "Stop this bot's turn before deleting its computer"
                : `Delete ${name}'s computer`
            }
          >
            <Trash width={14} height={14} aria-hidden="true" />
            Delete this bot's computer
          </button>
        ) : null}
      </div>
    </div>
  );
}
