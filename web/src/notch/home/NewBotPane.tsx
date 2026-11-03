import { type FormEvent, useEffect, useRef, useState } from "react";

import type { MemberAvatar } from "../../api/memberTypes";
import { NotchBot } from "../NotchBot";

export interface NewBotPaneProps {
  leadSlug: string;
  leadName: string;
  leadAvatar?: MemberAvatar;
  sending: boolean;
  /** Hands the answer to the lead, who drafts and hires the bot. */
  onSubmit: (what: string) => void;
}

/** What the lead asks before it hires someone new. */
export const NEW_BOT_ASK = "What would you like this new bot to do?";

/** The words sent to the lead, so it knows to hire rather than do it itself. */
export function newBotRequest(what: string): string {
  return `Hire a new bot for me. What it should do: ${what.trim()}`;
}

/**
 * A new bot starts as a conversation with the lead: it asks what the bot
 * should do, you say it in a line (or brainstorm), and the lead drafts
 * the bot and hires it in its chat, where you can adjust it.
 */
export function NewBotPane(props: NewBotPaneProps) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && !props.sending) props.onSubmit(text);
  };
  return (
    <section
      className="npane nnew"
      aria-label="New bot"
      data-testid="notch-new-bot"
    >
      <div className="nnew-stage">
        <div className="nnew-bubbles">
          <p className="nbubble">{NEW_BOT_ASK}</p>
          <p className="nbubble">
            Not sure yet? Say what eats your week and we can brainstorm.
          </p>
        </div>
        <NotchBot
          slug={props.leadSlug}
          avatar={props.leadAvatar}
          mood="idle"
          size={96}
          awake={true}
          label={props.leadName}
        />
      </div>
      <form className="nnew-form" onSubmit={submit}>
        <input
          ref={input}
          aria-label="What the new bot should do"
          placeholder="Type your answer"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          className="nbtn is-primary"
          disabled={props.sending || !text.trim()}
        >
          {props.sending ? "Sending" : `Ask ${props.leadName}`}
        </button>
      </form>
    </section>
  );
}
