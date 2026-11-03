import { post } from "../api/client";
import {
  getIntegrationConnectStatus,
  type IntegrationConnectResult,
  startIntegrationConnection,
} from "../api/integrations";
import { isInMacApp, postNative } from "./bridge";

/** The hint was on screen today: counts toward its once-a-day. Owner only. */
export function markHintSeen(platform: string) {
  return post("/notch/hint/seen", { platform }).then(() => undefined);
}

/** Not now: twice, and the platform is never hinted again. Owner only. */
export function dismissHint(platform: string) {
  return post("/notch/hint/dismiss", { platform }).then(() => undefined);
}

/**
 * Begins connecting the platform. The sign-in page opens in the person's
 * browser: the Mac app opens it, a plain page falls back to window.open.
 * Returns what the broker said, so the caller can poll for completion.
 */
export async function connectFromHint(
  platform: string,
): Promise<IntegrationConnectResult> {
  const result = await startIntegrationConnection("composio", platform);
  if (result.auth_url) {
    openInBrowser(result.auth_url);
  }
  return result;
}

/** Opens an https page in the default browser, never anything else. */
export function openInBrowser(url: string): void {
  if (!/^https:\/\//i.test(url)) return;
  if (isInMacApp()) {
    postNative({ type: "browse", url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** One look at whether the connection the person started has landed. */
export function hintConnectStatus(platform: string, connectId?: string) {
  return getIntegrationConnectStatus({
    provider: "composio",
    platform,
    connect_id: connectId,
  });
}
