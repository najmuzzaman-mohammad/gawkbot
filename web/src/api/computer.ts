// Typed wrappers for the bot-computer routes. Wire contract: see
// docs/specs/gawkbot-bot-computers.md, "Wire contract (locked 2026-09-01)".
// The broker speaks snake_case; everything exported from here is camelCase
// and already normalised so components never touch the raw wire shape.
import { get, post } from "./client";

// ── Member-level setting ────────────────────────────────────────

/** `officeMember.computer` on the wire. "" means auto. */
export type ComputerMemberSetting = "" | "off" | "sandbox" | "cloud";
/** Effective destination reported by `GET /computer/{slug}`. */
export type ComputerDestination = "off" | "sandbox" | "cloud";
export type ComputerCloudBackend = "box";

export const COMPUTER_STATES = [
  "off",
  "unconfigured",
  "runtime_missing",
  "image_missing",
  "building",
  "missing",
  "provisioning",
  "starting",
  "waking",
  "ready",
  "asleep",
  "error",
] as const;
export type ComputerState = (typeof COMPUTER_STATES)[number];

export function isComputerState(value: unknown): value is ComputerState {
  return (
    typeof value === "string" &&
    (COMPUTER_STATES as readonly string[]).includes(value)
  );
}

// ── Runtime (machine-wide) ──────────────────────────────────────

export type ComputerRuntimeKind = "docker" | "podman" | "container" | "";

export interface ComputerRuntime {
  available: boolean;
  runtime: ComputerRuntimeKind;
  daemonUp: boolean;
  image: boolean;
  imageRef: string;
  driverVersion: string;
  building: boolean;
  installHint: string;
  runtimeStartHint: string;
  problem: string;
}

interface ComputerRuntimeWire {
  available?: boolean;
  runtime?: string;
  daemon_up?: boolean;
  image?: boolean;
  image_ref?: string;
  driver_version?: string;
  building?: boolean;
  install_hint?: string;
  runtime_start_hint?: string;
  problem?: string;
}

function runtimeKind(raw: unknown): ComputerRuntimeKind {
  return raw === "docker" || raw === "podman" || raw === "container" ? raw : "";
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function strOrNull(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function normalizeComputerRuntime(
  wire: ComputerRuntimeWire,
): ComputerRuntime {
  return {
    available: wire.available === true,
    runtime: runtimeKind(wire.runtime),
    daemonUp: wire.daemon_up === true,
    image: wire.image === true,
    imageRef: str(wire.image_ref),
    driverVersion: str(wire.driver_version),
    building: wire.building === true,
    installHint: str(wire.install_hint),
    runtimeStartHint: str(wire.runtime_start_hint),
    problem: str(wire.problem),
  };
}

export async function getComputerRuntime(): Promise<ComputerRuntime> {
  const res = await get<ComputerRuntimeWire>("/computer/runtime");
  return normalizeComputerRuntime(res ?? {});
}

export async function prepareComputerRuntime(): Promise<{ building: boolean }> {
  const res = await post<{ building?: boolean }>(
    "/computer/runtime/prepare",
    {},
  );
  return { building: res?.building === true };
}

// ── Per-bot computer ──────────────────────────────────────────

export interface ComputerControl {
  held: boolean;
  helpReason: string | null;
}

export interface ComputerFrame {
  dataUrl: string;
  at: number;
}

export interface ComputerBox {
  boxId: string;
  state: string;
}

export interface ComputerStatus {
  slug: string;
  destination: ComputerDestination;
  cloudBackend: ComputerCloudBackend;
  state: ComputerState;
  problem: string | null;
  busy: boolean;
  /** Signed noVNC page for the live desktop (view policy). Expires. */
  viewerUrl: string | null;
  control: ComputerControl;
  lastFrame: ComputerFrame | null;
  containerName: string | null;
  workspaceDir: string | null;
  box: ComputerBox | null;
}

interface ComputerStatusWire {
  slug?: string;
  destination?: string;
  cloud_backend?: string;
  state?: string;
  problem?: string | null;
  busy?: boolean;
  viewer_url?: string | null;
  control?: { held?: boolean; help_reason?: string | null } | null;
  last_frame?: { data_url?: string; at?: number } | null;
  container_name?: string | null;
  workspace_dir?: string | null;
  box?: { box_id?: string; state?: string } | null;
}

function destination(raw: unknown): ComputerDestination {
  return raw === "sandbox" || raw === "cloud" ? raw : "off";
}

export function normalizeComputerStatus(
  wire: ComputerStatusWire,
): ComputerStatus {
  const frame =
    wire.last_frame && typeof wire.last_frame.data_url === "string"
      ? {
          dataUrl: wire.last_frame.data_url,
          at: typeof wire.last_frame.at === "number" ? wire.last_frame.at : 0,
        }
      : null;
  const box =
    wire.box && typeof wire.box.box_id === "string"
      ? { boxId: wire.box.box_id, state: str(wire.box.state) }
      : null;
  return {
    slug: str(wire.slug),
    destination: destination(wire.destination),
    cloudBackend: "box",
    // An unknown state is surfaced as an error rather than guessed, so the
    // UI never claims a computer exists when the broker said something new.
    state: isComputerState(wire.state) ? wire.state : "error",
    problem: strOrNull(wire.problem),
    busy: wire.busy === true,
    viewerUrl: strOrNull(wire.viewer_url),
    control: {
      held: wire.control?.held === true,
      helpReason: strOrNull(wire.control?.help_reason),
    },
    lastFrame: frame,
    containerName: strOrNull(wire.container_name),
    workspaceDir: strOrNull(wire.workspace_dir),
    box,
  };
}

function slugPath(slug: string): string {
  return `/computer/${encodeURIComponent(slug)}`;
}

export async function getComputer(slug: string): Promise<ComputerStatus> {
  const res = await get<ComputerStatusWire>(slugPath(slug));
  return normalizeComputerStatus(res ?? {});
}

export type ComputerAction = "provision" | "start" | "sleep" | "remove";

export async function computerAction(
  slug: string,
  action: ComputerAction,
): Promise<ComputerStatus> {
  const res = await post<ComputerStatusWire>(`${slugPath(slug)}/${action}`, {});
  return normalizeComputerStatus(res ?? {});
}

export async function computerScreenshot(
  slug: string,
): Promise<{ image: string }> {
  const res = await post<{ image?: string }>(
    `${slugPath(slug)}/screenshot`,
    {},
  );
  return { image: str(res?.image) };
}

export interface ComputerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function computerExec(
  slug: string,
  command: string,
): Promise<ComputerExecResult> {
  const res = await post<{
    exit_code?: number;
    stdout?: string;
    stderr?: string;
  }>(`${slugPath(slug)}/exec`, { command });
  return {
    exitCode: typeof res?.exit_code === "number" ? res.exit_code : 0,
    stdout: str(res?.stdout),
    stderr: str(res?.stderr),
  };
}

/** Control policy viewer. The broker takes the hold before answering. */
export async function computerJoin(
  slug: string,
): Promise<{ viewerUrl: string }> {
  const res = await post<{ viewer_url?: string }>(`${slugPath(slug)}/join`, {});
  return { viewerUrl: str(res?.viewer_url) };
}

export type ComputerControlAction = "take" | "release" | "dismiss-help";

export async function computerControl(
  slug: string,
  action: ComputerControlAction,
): Promise<ComputerControl> {
  const res = await post<{ held?: boolean; help_reason?: string | null }>(
    `${slugPath(slug)}/control`,
    { action },
  );
  return {
    held: res?.held === true,
    helpReason: strOrNull(res?.help_reason),
  };
}

/**
 * Where a bot's computer runs. Goes through the existing office-members
 * update action rather than a computer route, per the contract.
 */
export async function updateMemberComputer(
  slug: string,
  computer: ComputerMemberSetting,
): Promise<void> {
  await post("/office-members", { action: "update", slug, computer });
}

// ── SSE ─────────────────────────────────────────────────────────

/** `computer` SSE payload. `slug` is "" for machine-wide runtime events. */
export interface ComputerEventPayload {
  slug: string;
  state: string;
  problem?: string;
  message?: string;
  frame?: string;
  at?: number;
  held?: boolean;
  help_reason?: string | null;
}

export function parseComputerEvent(raw: string): ComputerEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.slug !== "string" || typeof obj.state !== "string") {
    return null;
  }
  return obj as unknown as ComputerEventPayload;
}

export const COMPUTER_QUERY_KEY = "computer";
export const COMPUTER_RUNTIME_QUERY_KEY = ["computer-runtime"] as const;

export function computerQueryKey(slug: string) {
  return [COMPUTER_QUERY_KEY, slug] as const;
}

// ── Sign in to ascii.dev (Box CLI flow, broker_box_signin.go) ────────────

export type BoxSigninStatus =
  | "idle"
  | "installing"
  | "cli_missing"
  | "awaiting_login"
  | "provisioning"
  | "done"
  | "error";

export interface BoxSigninState {
  status: BoxSigninStatus;
  authUrl: string;
  installCommand: string;
  reason: string;
}

interface BoxSigninWire {
  status?: string;
  auth_url?: string;
  install_command?: string;
  reason?: string;
}

const BOX_SIGNIN_STATUSES: readonly BoxSigninStatus[] = [
  "idle",
  "installing",
  "cli_missing",
  "awaiting_login",
  "provisioning",
  "done",
  "error",
];

export function normalizeBoxSigninState(wire: BoxSigninWire): BoxSigninState {
  const status = BOX_SIGNIN_STATUSES.includes(wire.status as BoxSigninStatus)
    ? (wire.status as BoxSigninStatus)
    : "error";
  return {
    status,
    authUrl: wire.auth_url ?? "",
    installCommand: wire.install_command ?? "",
    reason: wire.reason ?? "",
  };
}

export async function startBoxSignin(): Promise<BoxSigninState> {
  return normalizeBoxSigninState(
    await post<BoxSigninWire>("/computer/box/signin/start", {}),
  );
}

export async function getBoxSigninStatus(): Promise<BoxSigninState> {
  return normalizeBoxSigninState(
    await get<BoxSigninWire>("/computer/box/signin/status"),
  );
}

// ── Box account: session, key, and the plan gate ─────────────────────────

export interface BoxAccount {
  keySet: boolean;
  signedIn: boolean;
  identifier: string;
  cliInstalled: boolean;
  /** null when unknown (not signed in). false means no box will start. */
  canStart: boolean | null;
  blockedReason: string;
  plan: string;
  trialLine: string;
  billingUrl: string;
}

interface BoxAccountWire {
  key_set?: boolean;
  signed_in?: boolean;
  identifier?: string;
  cli_installed?: boolean;
  can_start?: boolean | null;
  blocked_reason?: string;
  plan?: string;
  trial_line?: string;
  billing_url?: string;
}

export const BOX_BILLING_URL =
  "https://box.ascii.dev/box/dashboard?tab=billing";

export function normalizeBoxAccount(wire: BoxAccountWire): BoxAccount {
  return {
    keySet: wire.key_set === true,
    signedIn: wire.signed_in === true,
    identifier: wire.identifier ?? "",
    cliInstalled: wire.cli_installed === true,
    canStart: typeof wire.can_start === "boolean" ? wire.can_start : null,
    blockedReason: wire.blocked_reason ?? "",
    plan: wire.plan ?? "",
    trialLine: wire.trial_line ?? "",
    billingUrl: wire.billing_url || BOX_BILLING_URL,
  };
}

export async function getBoxAccount(fresh = false): Promise<BoxAccount> {
  return normalizeBoxAccount(
    await get<BoxAccountWire>(
      "/computer/box/account",
      fresh ? { fresh: "1" } : undefined,
    ),
  );
}

export interface BoxSignoutResult {
  revokedKeys: number;
  loggedOut: boolean;
  account: BoxAccount;
}

export async function signOutBox(): Promise<BoxSignoutResult> {
  const wire = await post<{
    revoked_keys?: number;
    logged_out?: boolean;
    account?: BoxAccountWire;
  }>("/computer/box/signout", {});
  return {
    revokedKeys: wire.revoked_keys ?? 0,
    loggedOut: wire.logged_out === true,
    account: normalizeBoxAccount(wire.account ?? {}),
  };
}

/** Plain words for the provider's blocked_reason codes. */
export function describeBoxBlock(reason: string): string {
  switch (reason) {
    case "subscription_required":
      return "ascii.dev needs a plan before it will start a box. The 7-day trial counts.";
    case "suspended":
      return "ascii.dev has suspended this account.";
    case "":
      return "";
    default:
      return `ascii.dev will not start a box right now (${reason.replaceAll("_", " ")}).`;
  }
}

export async function cancelBoxSignin(): Promise<void> {
  await post("/computer/box/signin/cancel", {});
}
