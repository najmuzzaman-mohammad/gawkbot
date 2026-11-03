import { type FormEvent, type KeyboardEvent, useEffect, useRef } from "react";

import type { MemberAvatar } from "../api/memberTypes";
import { NotchBot } from "./NotchBot";
import type { ComposerState } from "./shared";

/**
 * The box at the bottom of a chat: the bot's face sitting on a microphone
 * to hold, the text field with send, and Stop while the bot works. The
 * same box answers a question the bot asked; it is remounted per target
 * so it focuses once.
 */
export function Composer({
  composer,
  sending,
  voiceAvailable,
  face,
  onText,
  onSubmit,
  onCancel,
  onVoice,
  onKeyboard,
  onStop,
}: {
  composer: ComposerState;
  sending: boolean;
  voiceAvailable: boolean;
  /** Whose face sits on the microphone. */
  face?: { slug: string; avatar?: MemberAvatar };
  onText: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onVoice: (on: boolean) => void;
  onKeyboard: (active: boolean) => void;
  /** Stops the bot's running turn; absent while it is not working. */
  onStop?: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  // Esc is handled once, by the window key handler (hooks.ts): it cancels
  // this reply first and only closes the notch when nothing is being typed.
  useEffect(() => {
    input.current?.focus();
  }, []);
  const answering = composer.target.kind === "answer";
  const to =
    composer.target.kind === "answer"
      ? composer.target.to
      : composer.target.name;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (composer.text.trim() && !sending) onSubmit();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <form
      className={`ncompose${composer.listening ? " is-listening" : ""}`}
      onSubmit={submit}
    >
      {answering ? (
        <div className="ncompose-to">
          Answering <b>{to}</b>
          <button
            type="button"
            className="ncompose-x"
            aria-label="Cancel reply"
            onClick={onCancel}
          >
            Esc
          </button>
        </div>
      ) : null}
      <div className="ncompose-row">
        {voiceAvailable ? (
          <button
            type="button"
            className={`nmic${composer.listening ? " is-on" : ""}`}
            aria-label={composer.listening ? "Stop listening" : "Hold to talk"}
            aria-pressed={composer.listening}
            onPointerDown={() => onVoice(true)}
            onPointerUp={() => onVoice(false)}
            onPointerLeave={() => composer.listening && onVoice(false)}
          >
            {face ? (
              <span className="nmic-face" aria-hidden="true">
                <NotchBot
                  slug={face.slug}
                  avatar={face.avatar}
                  mood={composer.listening ? "working" : "idle"}
                  size={30}
                  bare={true}
                  badge={false}
                  label=""
                />
              </span>
            ) : null}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
              <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" />
            </svg>
          </button>
        ) : null}
        <div className="ncompose-field">
          <textarea
            ref={input}
            rows={1}
            aria-label={`Reply to ${to}`}
            placeholder={composer.listening ? "Listening…" : `Message ${to}…`}
            value={composer.text}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={onKey}
            onFocus={() => onKeyboard(true)}
            onBlur={() => onKeyboard(false)}
          />
          <button
            type="submit"
            className="nsend"
            aria-label={sending ? "Sending" : "Send"}
            disabled={sending || !composer.text.trim()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        </div>
        {onStop ? (
          <button
            type="button"
            className="nstop"
            aria-label={`Stop ${to}`}
            title="Stop"
            onClick={onStop}
          >
            <i aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className="ncompose-hint">
        Return to send · Shift Return for a new line
        {voiceAvailable ? " · hold V to talk" : ""}
      </p>
    </form>
  );
}
