// Capture the operator sidebar's real-inventory-only Agents rail (PR #1163):
// the rail and its count badge show ONLY agents actually built on the broker —
// no mock drafts, no "Suggested" section, and an honest empty state before the
// first build.
//
// Run via the wrapper:
//   web/e2e/screenshots/publish.sh operator-suggested-agents <pr-number>

import process from "node:process";

import { DEFAULT_BASE, launchBrowser, shotElement } from "./lib.mjs";

const OUT = process.env.WUPHF_SCREENSHOTS_OUT;
if (!OUT) {
  console.error("WUPHF_SCREENSHOTS_OUT is not set; run via publish.sh");
  process.exit(2);
}

const REAL_APPS = [
  {
    id: "app_325c3475e74882f2",
    slug: "lead-routing-agent",
    name: "Lead Routing Agent",
    icon: "🎯",
    summary: "Score inbound demo requests and route hot leads to #ae-handoffs",
    entry: "index.html",
    version: 2,
    status: "ready",
  },
  {
    id: "app_f5fc7295e339ed80",
    slug: "refund-approvals",
    name: "Refund Approvals",
    icon: "🧾",
    summary: "Approve refunds and post confirmations to Slack",
    entry: "index.html",
    version: 1,
    status: "ready",
  },
];

const { browser, context, page } = await launchBrowser();

// The operator shell mounts at /#/operator ahead of the office gates, so no
// bootShell/store flip is needed — just a deterministic /apps payload.
let apps = REAL_APPS;
await context.route("**/api/apps", (r) => r.fulfill({ json: { apps } }));
await context.route("**/api/requests*", (r) =>
  r.fulfill({ json: { requests: [] } }),
);
await context.route("**/web-token", (r) =>
  r.fulfill({ json: { token: "screenshot-token" } }),
);

await page.goto(`${DEFAULT_BASE}/?token=screenshot-token#/operator`, {
  waitUntil: "load",
});
await page.waitForSelector(".opr-sidebar", { timeout: 15_000 });

// 1. Two real agents: badge says 2, the rail lists exactly them, and there is
//    no Suggested section anywhere.
await page.waitForSelector(".opr-agent-rail-item", { timeout: 10_000 });
await shotElement(page, ".opr-sidebar", OUT, "01-sidebar-real-agents-only");

// 2. Empty workspace: no badge, no mock drafts — just the build affordances.
apps = [];
await page.reload({ waitUntil: "load" });
await page.waitForSelector(".opr-sidebar", { timeout: 15_000 });
// Assert the rail is actually gone (not a fixed sleep): capturing a stale
// rail here would silently reintroduce the bug this spec guards against.
await page.waitForFunction(
  () => !document.querySelector(".opr-agent-rail-item"),
  { timeout: 10_000 },
);
await shotElement(page, ".opr-sidebar", OUT, "02-sidebar-empty-honest");

await browser.close();
