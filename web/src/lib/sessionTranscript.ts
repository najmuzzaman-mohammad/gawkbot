import { useQuery } from "@tanstack/react-query";

import { get, type Message } from "../api/client";

// A terminal session's own conversation, read from its log by the broker,
// merged into its DM so the session's page reads like its terminal: what
// the person typed there and what the agent wrote, plus anything sent from
// gawkbot, each once.

export interface SessionTurn {
  from: "human" | "agent";
  text: string;
  at?: string;
}

/** The id prefix of a message that came from the session's log. */
export const TERMINAL_MESSAGE_PREFIX = "term-";

export function isTerminalMessage(m: Pick<Message, "id">): boolean {
  return m.id.startsWith(TERMINAL_MESSAGE_PREFIX);
}

export function getSessionTranscript(slug: string) {
  return get<{ turns: SessionTurn[] }>(
    `/agents/local/sessions/transcript?slug=${encodeURIComponent(slug)}`,
  );
}

export function useSessionTranscript(slug: string | null) {
  return useQuery({
    queryKey: ["session-transcript", slug],
    queryFn: () => getSessionTranscript(slug ?? ""),
    enabled: slug !== null,
    refetchInterval: 3000,
    select: (data) => data.turns ?? [],
  });
}

function same(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The DM and the session's log as one conversation, in time order. A DM
 * message the log also has (sent from gawkbot, then typed into the
 * terminal; or the answer read back from the log) shows once, as the DM's.
 * Returns a new array; neither input is touched.
 */
export function mergeTranscript(
  dm: readonly Message[],
  turns: readonly SessionTurn[],
  slug: string,
  channel: string,
): Message[] {
  const inDM = new Set(
    dm.map((m) => `${m.from === slug ? "agent" : "human"}:${same(m.content)}`),
  );
  const fromLog: Message[] = turns
    .filter((t) => !inDM.has(`${t.from}:${same(t.text)}`))
    .map((t, i) => ({
      id: `${TERMINAL_MESSAGE_PREFIX}${i}-${t.at ?? ""}`,
      from: t.from === "agent" ? slug : "you",
      channel,
      content: t.text,
      timestamp: t.at ?? "",
    }));
  const at = (m: Message) => {
    const t = Date.parse(m.timestamp);
    return Number.isFinite(t) ? t : 0;
  };
  return [...dm, ...fromLog].sort((a, c) => at(a) - at(c));
}
