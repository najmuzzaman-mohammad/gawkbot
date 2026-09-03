/**
 * AppRefLink — the rendered form of an inline app reference in chat prose.
 *
 * Mirrors TaskRefLink, for the same reason and with the same two properties:
 *
 *  1. It reads as what the app IS. An `app_9f3c1d…` id in a sentence tells a
 *     human nothing, so the pill resolves to the app's NAME and keeps the id
 *     only as the hover title. (A task pill shows id AND title because the id
 *     is the handle people quote back to bots; an app id is a hash nobody
 *     quotes, so the name carries it alone.)
 *  2. Clicking opens the app, rather than leaving the reader to hunt the
 *     sidebar for something they were just told about.
 *
 * Names come from the sidebar's own `["apps"]` cache, read through
 * QueryClientContext directly rather than useQuery — chat markdown renders in
 * tests and isolated stories with no QueryClientProvider above it, where
 * useQuery throws. A missing name must degrade to the id, never to a crash.
 */

import {
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import { QueryClientContext } from "@tanstack/react-query";

const APPS_LIST_KEY = ["apps"] as const;

interface AppSummary {
  readonly id: string;
  readonly name?: string;
  readonly status?: string;
}

/** Resolve an app id to its display name from the sidebar's cache. */
export function useAppName(appId: string): string | undefined {
  const client = useContext(QueryClientContext);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!client) return () => {};
      return client.getQueryCache().subscribe(onStoreChange);
    },
    [client],
  );

  const getSnapshot = useCallback(() => {
    if (!(client && appId)) return undefined;
    const data = client.getQueryData<AppSummary[]>(APPS_LIST_KEY);
    if (!Array.isArray(data)) return undefined;
    const wanted = appId.toLowerCase();
    const match =
      data.find((a) => a.id === appId) ??
      data.find((a) => a.id?.toLowerCase() === wanted);
    const name = (match?.name ?? "").trim();
    return name || undefined;
  }, [client, appId]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface AppRefLinkProps {
  readonly appId: string;
  readonly children?: ReactNode;
}

export function AppRefLink({ appId, children }: AppRefLinkProps) {
  const name = useAppName(appId);

  return (
    <a
      className="msg-app-link"
      href={`#/apps/${appId}`}
      data-app-id={appId}
      // The id stays reachable on hover: it is what a bot will have been
      // given, so a human occasionally needs to read it back.
      title={name ? `${name} · ${appId}` : appId}
      aria-label={name ? `Open app ${name}` : `Open app ${appId}`}
    >
      <span className="msg-app-link-glyph" aria-hidden="true">
        ▦
      </span>
      <span className="msg-app-link-name">{name ?? children ?? appId}</span>
    </a>
  );
}
