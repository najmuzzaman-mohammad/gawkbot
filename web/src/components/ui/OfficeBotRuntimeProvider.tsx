import { type ReactNode, useCallback, useMemo } from "react";

import { useOfficeMembers } from "../../hooks/useMembers";
import { type BotRuntime, BotRuntimeContext } from "../../lib/botRuntime";

/**
 * Feeds every avatar in the app its bot's runtime from the office roster.
 * It shares the `office-members` query the sidebar already polls, so it adds
 * no request of its own.
 */
export function OfficeBotRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { data: members } = useOfficeMembers();
  const bySlug = useMemo(() => {
    const map = new Map<string, BotRuntime>();
    for (const m of members ?? []) {
      if (m.runtime?.harness) map.set(m.slug, m.runtime);
    }
    return map;
  }, [members]);
  const lookup = useCallback((slug: string) => bySlug.get(slug), [bySlug]);
  return (
    <BotRuntimeContext.Provider value={lookup}>
      {children}
    </BotRuntimeContext.Provider>
  );
}
