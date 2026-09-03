// Capture the per-agent Computer tab through its phases: off, no runtime,
// live desktop, help requested, and the person holding the wheel. Plus theme
// coverage for the live state.
//
// Run via:
//   web/e2e/screenshots/publish.sh bot-computer <pr-number>

import {
  bootShell,
  installCommonMocks,
  launchBrowser,
  shotElement,
} from "./lib.mjs";
import process from "node:process";

const OUT = process.env.WUPHF_SCREENSHOTS_OUT;
if (!OUT) {
  console.error("WUPHF_SCREENSHOTS_OUT is not set; run via publish.sh");
  process.exit(2);
}

const LLM_KINDS = [
  "claude-code",
  "codex",
  "opencode",
  "mlx-lm",
  "ollama",
  "exo",
];

// Mutable: the route handlers read it, so a shot can flip the phase and
// remount the tab without re-registering routes.
const scenario = {
  state: "off",
  destination: "off",
  viewer: false,
  frame: false,
  held: false,
  helpReason: null,
  boxKeySet: false,
  computer: "off",
};

const CONFIG = () => ({
  llm_provider: "claude-code",
  llm_provider_configured: true,
  llm_provider_priority: [],
  llm_provider_kinds: LLM_KINDS,
  gateway_kinds: ["openclaw", "openclaw-http", "hermes-agent"],
  provider_endpoints: {},
  memory_backend: "markdown",
  action_provider: "auto",
  team_lead_slug: "ceo",
  company_name: "Northwind",
  config_path: "/Users/you/.wuphf/config.json",
  box_key_set: scenario.boxKeySet,
});

const MEMBERS = () => ({
  members: [
    {
      slug: "ceo",
      name: "CEO",
      role: "Office lead",
      status: "idle",
      activity: "idle",
      built_in: true,
      online: true,
      provider: { kind: "claude-code", model: "claude-opus-4-8" },
    },
    {
      slug: "growth",
      name: "Growth Lead",
      role: "Demand generation and pipeline",
      status: "active",
      activity: "filing invoices",
      task: "File the three invoices into Xero",
      built_in: false,
      online: true,
      provider: { kind: "claude-code", model: "claude-opus-4-8" },
      computer: scenario.computer,
    },
  ],
});

const CHANNELS = {
  channels: [
    { slug: "general", name: "general", members: ["ceo", "growth"] },
    {
      slug: "growth__human",
      name: "Growth Lead",
      members: ["growth"],
      type: "dm",
    },
  ],
};

// A stand-in desktop drawn as SVG so the shot has a picture.
const FRAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
  <rect width="1280" height="800" fill="#2b2f3a"/>
  <rect x="0" y="0" width="1280" height="28" fill="#1c1f27"/>
  <text x="14" y="19" font-family="sans-serif" font-size="13" fill="#c8ccd6">Applications  Places</text>
  <rect x="120" y="90" width="1040" height="620" rx="8" fill="#f4f5f7"/>
  <rect x="120" y="90" width="1040" height="40" rx="8" fill="#e2e4e9"/>
  <text x="140" y="116" font-family="sans-serif" font-size="14" fill="#333">Xero — Bills to pay</text>
  <text x="160" y="200" font-family="sans-serif" font-size="16" fill="#222">Invoice #1042 · Northwind Traders · $1,240.00</text>
  <text x="160" y="240" font-family="sans-serif" font-size="16" fill="#222">Invoice #1043 · Globex · $980.00</text>
  <text x="160" y="280" font-family="sans-serif" font-size="16" fill="#222">Invoice #1044 · Initech · $2,310.50</text>
</svg>`;
const FRAME_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(FRAME_SVG)}`;
const VIEWER_HTML = `<!doctype html><html><body style="margin:0;background:#2b2f3a;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#c8ccd6"><div style="text-align:center"><div style="font-size:14px;margin-bottom:6px">noVNC · live desktop</div><div style="font-size:11px;opacity:.7">stubbed viewer for the screenshot harness</div></div></body></html>`;
const VIEWER_DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(VIEWER_HTML)}`;

const STATUS = () => ({
  slug: "growth",
  destination: scenario.destination,
  cloud_backend: "box",
  state: scenario.state,
  problem: null,
  busy: false,
  viewer_url: scenario.viewer ? VIEWER_DATA_URL : null,
  control: { held: scenario.held, help_reason: scenario.helpReason },
  last_frame: scenario.frame ? { data_url: FRAME_DATA_URL, at: 1 } : null,
  container_name: "gawkbot-computer-3f2a9c1b7d4e6f08",
  workspace_dir: "~/.gawkbot/computers/3f2a9c1b7d4e6f08",
  box: null,
});

const RUNTIME = () => ({
  available: scenario.state !== "runtime_missing",
  runtime: scenario.state === "runtime_missing" ? "" : "docker",
  daemon_up: true,
  image: scenario.state === "ready",
  image_ref: "gawkbot/computer:cua-0.20.0",
  driver_version: "0.20.0",
  building: false,
  install_hint:
    "No docker, podman, or container CLI found. OrbStack installs docker in one step.",
  runtime_start_hint: "",
  problem: "",
});

function json(r, body) {
  r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

async function mockFeature(ctx) {
  await ctx.route("**/api/config", (r) => json(r, CONFIG()));
  await ctx.route("**/api/office-members", (r) => json(r, MEMBERS()));
  await ctx.route("**/api/channels", (r) => json(r, CHANNELS));
  await ctx.route("**/api/status/local-providers", (r) =>
    r.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await ctx.route("**/api/messages*", (r) => json(r, { messages: [] }));
  // Host-anchored: a plain "**/api/computer*" glob would also match Vite's
  // module request for /src/api/computer.ts and break the app boot.
  await ctx.route(/\/\/[^/]+\/api\/computer\/runtime(\?|$)/, (r) =>
    json(r, RUNTIME()),
  );
  await ctx.route(/\/\/[^/]+\/api\/computer\/growth(\/[a-z-]+)?(\?|$)/, (r) =>
    json(r, STATUS()),
  );
}

const { browser, context, page } = await launchBrowser({
  viewport: { width: 1480, height: 1000 },
});

page.on("pageerror", (err) => console.error(`[pageerror] ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error(`[console.error] ${msg.text()}`);
});

async function openComputerTab() {
  // Bounce through Chat so the Computer tab remounts and refetches the
  // status with the current scenario (the status query has staleTime 0).
  await page.evaluate(() => {
    window.location.hash = "/agents/growth/chat";
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    window.location.hash = "/agents/growth/computer";
  });
  await page.waitForSelector('[data-testid="computer-tab"]', {
    timeout: 10_000,
  });
  await page.waitForTimeout(600);
}

async function setTheme(id) {
  await page.evaluate(async (theme) => {
    const m = await import("/src/stores/app.ts");
    document.documentElement.setAttribute("data-theme", theme);
    const existing = document.getElementById("wuphf-theme-shot");
    if (existing) existing.remove();
    const link = document.createElement("link");
    link.id = "wuphf-theme-shot";
    link.rel = "stylesheet";
    link.href = `/themes/${theme}.css`;
    document.head.appendChild(link);
    if (m.useAppStore?.setState) {
      try {
        m.useAppStore.setState({ theme });
      } catch {
        /* the attr+link is what renders */
      }
    }
  }, id);
  await page.waitForTimeout(450);
}

await installCommonMocks(context, { extra: mockFeature });
await bootShell(page, { afterFlipSelector: ".status-bar" });

// 01 — off
await openComputerTab();
await shotElement(page, ".bot-subspace", OUT, "01-computer-off");

// 02 — no runtime: install OrbStack or paste a Box key, side by side
Object.assign(scenario, {
  state: "runtime_missing",
  destination: "sandbox",
  computer: "",
});
await openComputerTab();
await shotElement(page, ".bot-subspace", OUT, "02-runtime-missing");

// 03 — ready, live desktop in the noVNC iframe
Object.assign(scenario, { state: "ready", viewer: true, frame: true });
await openComputerTab();
await shotElement(page, ".bot-subspace", OUT, "03-ready-live");

// 04 — the bot asked for hands
Object.assign(scenario, {
  helpReason: "Xero is asking for a login and I do not have the password.",
});
await openComputerTab();
await shotElement(page, ".bot-subspace", OUT, "04-help-requested");

// 05 — you have the wheel
Object.assign(scenario, { helpReason: null, held: true });
await openComputerTab();
await shotElement(page, ".bot-subspace", OUT, "05-held");

// 06 — sidebar glyph: the bot is working on a ready computer
const agentsSection = page.locator('[data-testid="sidebar-section-agents"]');
if (await agentsSection.count()) {
  await shotElement(
    page,
    '[data-testid="sidebar-section-agents"]',
    OUT,
    "06-sidebar-on-computer",
  );
}

// ── Theme coverage on the live state ─────────────────────────────
Object.assign(scenario, { held: false });
await setTheme("nex-dark");
await openComputerTab();
await shotElement(page, ".bot-subspace", OUT, "07-ready-dark");

await setTheme("noir-gold");
await openComputerTab();
await shotElement(page, ".bot-subspace", OUT, "08-ready-noir");

Object.assign(scenario, {
  state: "runtime_missing",
  viewer: false,
  frame: false,
});
await openComputerTab();
await shotElement(page, ".bot-subspace", OUT, "09-runtime-missing-noir");

console.log(`captured screenshots to ${OUT}`);
await browser.close();
