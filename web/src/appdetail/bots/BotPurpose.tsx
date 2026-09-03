// BotPurpose — "what this bot is for", from the app's build description.
// Lives at the top of the bot detail, under the header.
//
// It used to append the workflows taught to the app in its own chat ("from N
// conversations"). Apps no longer author tools — that capability was removed
// with the Tools tab — so the line is just the bot's stated purpose again.

interface BotPurposeProps {
  /** The build-time description of the bot (may be empty). */
  summary?: string;
}

function sentenceCase(s: string): string {
  const t = s.trim().replace(/\.+$/, "");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function BotPurpose({ summary }: BotPurposeProps) {
  const base = summary?.trim() ? sentenceCase(summary) : null;
  if (!base) return null;

  return (
    <div className="opr-bot-purpose">
      <p className="opr-bot-purpose-text">{base}.</p>
    </div>
  );
}
