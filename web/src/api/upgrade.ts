import { get, postWithTimeout } from "./client";

export const UPGRADE_CHECK_QUERY_KEY = ["upgrade-check"] as const;

// LATEST_RELEASE_URL is where the Mac app ships. The broker sends the same
// link in upgrade_command by default (internal/upgradecheck
// DefaultUpgradeCommand); the UI keeps its own copy so an older broker
// that omits the field still gets a download link rather than a shell
// command to paste.
export const LATEST_RELEASE_URL =
  "https://github.com/najmuzzaman-mohammad/gawkbot/releases/latest";
export const DOWNLOAD_LATEST_INSTRUCTION = `Download the latest Mac app: ${LATEST_RELEASE_URL}`;

// canRunUpgrade is true only when the broker detected a package-manager
// install it can upgrade in place. Otherwise the upgrade path is the Mac
// app download, and the UI must not promise a click-to-install.
export function canRunUpgrade(
  check:
    | Pick<UpgradeCheckResponse, "install_method" | "install_command">
    | undefined,
): boolean {
  return !!(
    check?.install_command &&
    check.install_method &&
    check.install_method !== "unknown"
  );
}

export type UpgradeInstallMethod = "global" | "local" | "unknown";

export interface UpgradeCheckResponse {
  current: string;
  latest: string;
  upgrade_available: boolean;
  is_dev_build: boolean;
  compare_url?: string;
  upgrade_command: string;
  // Older brokers may omit these fields. When absent, the UI falls back
  // to upgrade_command.
  install_method?: UpgradeInstallMethod;
  install_command?: string;
  error?: string;
}

export interface UpgradeChangelogCommit {
  type: string;
  scope: string;
  description: string;
  pr: string;
  sha: string;
  breaking: boolean;
}

export interface UpgradeChangelogResponse {
  commits?: UpgradeChangelogCommit[];
  error?: string;
}

// UpgradeRunResult mirrors broker.upgradeRunResult. install_method is
// optional because the UI also synthesizes a result on transport failure,
// where no broker-side install method has been observed.
export interface UpgradeRunResult {
  ok: boolean;
  install_method?: UpgradeInstallMethod;
  command?: string;
  working_dir?: string;
  output?: string;
  error?: string;
  timed_out?: boolean;
}

export function getUpgradeCheck() {
  return get<UpgradeCheckResponse>("/upgrade-check");
}

export function getUpgradeChangelog(from: string, to: string) {
  return get<UpgradeChangelogResponse>("/upgrade-changelog", { from, to });
}

// runUpgrade asks the broker to upgrade the install it detected on its own
// host (a package-manager install; see canRunUpgrade). The 130s timeout is just above the broker-side
// upgradeRunTimeout (120s) so the client gives the server enough room to
// surface its own deadline error instead of failing first with a generic
// "fetch timed out".
export function runUpgrade() {
  return postWithTimeout<UpgradeRunResult>("/upgrade/run", {}, 130_000);
}
