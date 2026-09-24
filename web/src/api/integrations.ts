import { ApiError, get, post } from "./client";

export type IntegrationProvider = "composio" | "one" | string;

export interface IntegrationProviderStatus {
  provider: IntegrationProvider;
  label: string;
  configured: boolean;
  supports_connect: boolean;
  supports_disconnect: boolean;
  detail?: string;
  /**
   * The stored Composio credential is dead and the broker could not re-mint
   * one, so the only fix is a fresh browser sign-in. `detail` already carries
   * the human sentence; this flag tells the UI to offer the button.
   */
  needs_signin?: boolean;
}

export interface IntegrationConnection {
  platform: string;
  state?: string;
  key: string;
  name?: string;
  tags?: string[];
}

export interface IntegrationCatalogItem {
  provider: IntegrationProvider;
  platform: string;
  name: string;
  description?: string;
  category?: string;
  logo_url?: string;
  state: string;
  connection_key?: string;
  connection_name?: string;
  can_connect: boolean;
  can_disconnect: boolean;
  connections?: IntegrationConnection[];
  last_action_at?: string;
  last_action_summary?: string;
}

export interface IntegrationsResponse {
  providers: IntegrationProviderStatus[];
  items: IntegrationCatalogItem[];
  next_cursor?: string;
}

export interface ListIntegrationsParams {
  provider?: string;
  search?: string;
  connected?: string;
  limit?: number;
  cursor?: string;
}

/** One credential input for a non-OAuth toolkit (API key / token / password). */
export interface IntegrationConnectField {
  name: string;
  label: string;
  description?: string;
  /** Render as a masked password input. */
  secret?: boolean;
  required?: boolean;
}

export interface IntegrationConnectResult {
  provider: IntegrationProvider;
  platform: string;
  /** "needs_fields" means the UI must collect required_fields and POST them to
   * submitIntegrationCredentials before the toolkit is connected. */
  status: string;
  auth_url?: string;
  connect_id?: string;
  connection_key?: string;
  expires_at?: string;
  instructions?: string;
  auth_mode?: string;
  required_fields?: IntegrationConnectField[];
}

export interface IntegrationDisconnectResult {
  ok: boolean;
  provider: IntegrationProvider;
  platform?: string;
  connection_key: string;
  status: string;
}

export interface IntegrationAuditEvent {
  id: string;
  event_type: string;
  provider?: string;
  platform?: string;
  connection_key?: string;
  action_id?: string;
  status?: string;
  actor?: string;
  channel?: string;
  summary?: string;
  related_id?: string;
  created_at: string;
  metadata?: Record<string, string>;
}

export async function listIntegrations(
  params: ListIntegrationsParams = {},
): Promise<IntegrationsResponse> {
  return get<IntegrationsResponse>("/integrations", {
    provider: params.provider,
    search: params.search,
    connected: params.connected,
    limit: params.limit,
    cursor: params.cursor,
  });
}

export async function startIntegrationConnection(
  provider: IntegrationProvider,
  platform: string,
): Promise<IntegrationConnectResult> {
  return post<IntegrationConnectResult>("/integrations/connect", {
    provider,
    platform,
  });
}

/**
 * Complete a non-OAuth (API-key/token) connection by submitting the credentials
 * the user typed into the fields returned by `startIntegrationConnection` when
 * its status was "needs_fields".
 */
export async function submitIntegrationCredentials(
  provider: IntegrationProvider,
  platform: string,
  fields: Record<string, string>,
): Promise<IntegrationConnectResult> {
  return post<IntegrationConnectResult>("/integrations/connect-credentials", {
    provider,
    platform,
    fields,
  });
}

export async function getIntegrationConnectStatus(params: {
  provider: IntegrationProvider;
  platform?: string;
  connect_id?: string;
}): Promise<IntegrationConnectResult> {
  return get<IntegrationConnectResult>("/integrations/connect-status", params);
}

export async function disconnectIntegration(
  provider: IntegrationProvider,
  connectionKey: string,
  platform?: string,
): Promise<IntegrationDisconnectResult> {
  return post<IntegrationDisconnectResult>("/integrations/disconnect", {
    provider,
    platform,
    connection_key: connectionKey,
  });
}

export async function getIntegrationAudit(
  params: {
    provider?: string;
    platform?: string;
    connection_key?: string;
    limit?: number;
  } = {},
): Promise<IntegrationAuditEvent[]> {
  const resp = await get<{ events: IntegrationAuditEvent[] }>(
    "/integrations/audit",
    params,
  );
  return resp.events ?? [];
}

// ─── "Sign in with Composio" (broker-driven CLI flow) ───
// The broker shells out to the official composio CLI so the user never
// copy/pastes an API key. State machine mirrors
// internal/team/broker_composio_signin.go.

export type ComposioSigninStatus =
  | "idle"
  | "cli_missing"
  | "install_required"
  | "installing"
  | "awaiting_login"
  | "provisioning"
  | "done"
  | "error";

export interface ComposioSigninState {
  status: ComposioSigninStatus;
  auth_url?: string;
  install_command?: string;
  reason?: string;
}

/**
 * Start (or re-join) the Composio sign-in flow.
 *
 * `auto` marks a sign-in the user did not click for: the one a connect attempt
 * starts on their behalf. The broker treats it differently in two ways — it
 * will not install software without being asked, and it refuses to start
 * another one after the user cancelled or a flow failed, handing back `idle` so
 * this surface falls back to the explicit button.
 */
export async function startComposioSignin(
  options: { auto?: boolean } = {},
): Promise<ComposioSigninState> {
  return post<ComposioSigninState>("/integrations/composio/signin/start", {
    auto: options.auto === true,
  });
}

export async function getComposioSigninStatus(): Promise<ComposioSigninState> {
  return get<ComposioSigninState>("/integrations/composio/signin/status");
}

/** Abandon the current sign-in flow and return the broker to idle. */
export async function cancelComposioSignin(): Promise<ComposioSigninState> {
  return post<ComposioSigninState>("/integrations/composio/signin/cancel", {});
}

/**
 * The broker's machine-readable code for "Composio revoked this office's
 * credential and the silent re-mint could not replace it". Mirrors
 * composioSignInExpiredCode in internal/team/broker_integrations.go.
 */
export const COMPOSIO_SIGNIN_EXPIRED = "composio_signin_expired";

/**
 * True when a failed integration call was a dead Composio sign-in rather than
 * an outage. The UI branches on this to show the sign-in panel instead of an
 * error toast, so no surface has to recognise a 401 by its text.
 */
export function isComposioSigninExpired(error: unknown): boolean {
  return (
    error instanceof ApiError && error.errorCode === COMPOSIO_SIGNIN_EXPIRED
  );
}

/**
 * The broker's code for "this office has no Composio credential at all" — a
 * first run, rather than a credential that went stale. Mirrors
 * composioSignInRequiredCode in internal/team/broker_composio_autologin.go.
 */
export const COMPOSIO_SIGNIN_REQUIRED = "composio_signin_required";

/**
 * True when an integration call failed for want of a Composio sign-in, whether
 * the credential expired or was never there. Both are fixed by the same browser
 * sign-in, so every surface branches on this one predicate and only the
 * sentence above the panel differs.
 */
export function isComposioSigninNeeded(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.errorCode === COMPOSIO_SIGNIN_EXPIRED ||
      error.errorCode === COMPOSIO_SIGNIN_REQUIRED)
  );
}

/** True when the failure was "never signed in", not "sign-in expired". */
export function isComposioSigninMissing(error: unknown): boolean {
  return (
    error instanceof ApiError && error.errorCode === COMPOSIO_SIGNIN_REQUIRED
  );
}

/** The upstream request id for a failed call, for a support-details affordance. */
export function integrationErrorRequestId(error: unknown): string | null {
  return error instanceof ApiError ? error.requestId : null;
}
