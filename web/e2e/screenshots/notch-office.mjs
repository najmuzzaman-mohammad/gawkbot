// The notch's screens: the hover list, Home (sidebar of one Suggestions
// group, the bots, one Sessions group; a bot's chat with its question),
// the suggestions carousel, the sessions, a new bot, settings, and the
// cards at the top right. Runs against vite with every /api/* answered
// here, so no office is needed. Run via the wrapper:
//   web/e2e/screenshots/publish.sh --dry-run notch-office 0
import { chromium } from "@playwright/test";
import process from "node:process";

const BASE = process.env.BASE_URL ?? "http://localhost:5273";
const OUT = process.env.WUPHF_SCREENSHOTS_OUT;
if (!OUT) {
  console.error("WUPHF_SCREENSHOTS_OUT is not set; run via publish.sh");
  process.exit(2);
}

const AGENTS = [
  { slug: "cos", name: "Chief of Staff", mood: "idle", detail: "", is_lead: true, origin: "built_in", runs_on: "this_machine",
    runtime: { harness: "claude-code", harness_name: "Claude Code", model: "claude-opus-5-5", model_label: "Opus 5.5", family: "claude", source: "observed" },
    channel: "cos__human", last: { from: "cos", text: "Both bots are on it; I will say when they are done.", at: "2026-10-15T09:10:00Z" } },
  { slug: "ops", name: "Ops", mood: "working", detail: "moving 14 screenshots into Shots", channel: "human__ops",
    runtime: { harness: "claude-code", harness_name: "Claude Code", model: "claude-sonnet-5-5", model_label: "Sonnet 5.5", family: "claude", source: "observed" } },
  { slug: "release-checker", name: "Release Checker", mood: "working", detail: "reading the changes waiting on the deploy", channel: "human__release-checker" },
  { slug: "designer", name: "Designer", mood: "idle", detail: "", channel: "designer__human", unread: 2,
    last: { from: "designer", text: "Two options for the empty state are in the wiki; I lean to the quiet one.", at: "2026-10-15T09:05:00Z" } },
  { slug: "cc-1", name: "Fix the login redirect", mood: "idle", kind: "session", tool: "claude-code", tool_name: "Claude Code",
    project: "billing", state: "your_turn", updated_at: "2026-10-15T09:08:00Z", open: true, last_said: "Tests pass. Want me to merge it, or add a regression test first?" },
  { slug: "cx-2", name: "Plan the agent architecture", mood: "working", kind: "session", tool: "codex", tool_name: "Codex",
    project: "agentOS", state: "working", updated_at: "2026-10-15T09:09:00Z" },
];

const STATE = {
  lead: "cos", lead_name: "Chief of Staff", lead_dm: "cos__human",
  mood: "needs_you", headline: "1 thing needs you",
  attention: [
    { id: "req-1", kind: "ask", from: "ops", from_name: "Ops", channel: "human__ops",
      title: "Two of the screenshots are duplicates", question: "Leave them where they are, or move them too?",
      options: [{ id: "leave", label: "Leave them" }, { id: "move", label: "Move them too" }], recommended_id: "leave",
      created_at: new Date(Date.now() - 90_000).toISOString() },
  ],
  finished: [],
  agents: AGENTS,
  jump_out: true, announce: true,
  screen: { app: "Google Chrome", bundle_id: "com.google.Chrome", domain: "mail.google.com" },
  ideas: { enabled: true, checked_at: "2026-10-15T09:00:00Z", items: [
    { id: "idea:aaa", fingerprint: "aaa", name: "Release Checker", role: "Reads what waits on the deploy", integration: "github", integration_name: "GitHub",
      promise: "Before #4097 goes to production, I will read every change waiting on the deploy and call go or no go.",
      rationale: "Two pull requests wait on it right now.", cadence: "0 9 * * 1-5", cadence_label: "Every weekday at 9:00, while this Mac is awake",
      first_task: "Read #4097 and #4101 and say whether they are safe to ship.",
      evidence: [{ id: "github-1", platform: "github", text: "#4097 Ship the new deploy pipeline · open" }, { id: "github-2", platform: "github", text: "#4101 Fix flaky checkout test · open" }],
      avatar: { shape: "bear", color: "#64d2ff" }, created_at: "2026-10-15T09:00:00Z" },
    { id: "idea:bbb", fingerprint: "bbb", name: "Invoice Watcher", role: "Watches invoices", integration: "gmail", integration_name: "Gmail",
      promise: "When an invoice lands, like the one from Acme, I will log it and say so.", rationale: "One is unread now.", first_task: "Log the Acme invoice.",
      avatar: { shape: "cat", color: "#ff9f0a" }, created_at: "2026-10-15T09:00:00Z" },
  ] },
  hint: { platform: "gmail", name: "Gmail", line: "Connect Gmail so your bots can read this inbox", since: "2026-10-15T09:00:00Z" },
  capabilities: { voice_realtime: false, screen_context: true, screen_capture: false, pointer: true, mac_computer: true },
  permissions: { accessibility: true, screen_recording: true },
  lead_recent: [
    { from: "human", text: "Get the screenshots sorted and check the deploy", at: "2026-10-15T09:09:00Z" },
    { from: "cos", text: "Both bots are on it; I will say when they are done.", at: "2026-10-15T09:10:00Z" },
  ],
};

const THREAD = {
  messages: [
    { id: "msg-1", from: "human", channel: "designer__human", content: "Can you give me an empty state for the inbox?", timestamp: "2026-10-15T09:00:00Z", tagged: [] },
    { id: "msg-2", from: "designer", channel: "designer__human", content: "Two options for the empty state are in the wiki; I lean to the quiet one.", timestamp: "2026-10-15T09:05:00Z", tagged: [] },
    { id: "msg-3", from: "designer", channel: "designer__human", content: "Say the word and I will wire the quiet one into the app.", timestamp: "2026-10-15T09:06:00Z", tagged: [] },
  ],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
// Only the office's API, never vite's own /src/api/* modules.
const api = (path) => new RegExp("^" + BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + path);
// Playwright tries the last route registered first: the catch-all goes first.
await context.route(api("/api/"), (r) => r.fulfill({ json: {} }));
await context.route(api("/api/notch/"), (r) => r.fulfill({ json: { ok: true } }));
await context.route(api("/api-token"), (r) => r.fulfill({ json: { token: "t" } }));
await context.route(api("/api/events"), (r) => r.abort());
await context.route(api("/api/notch/state"), (r) => r.fulfill({ json: STATE }));
await context.route(api("/api/messages"), (r) => r.fulfill({ json: THREAD }));
await context.route(api("/api/realtime/status"), (r) => r.fulfill({ json: { configured: false } }));
const page = await context.newPage();
const errors = [];

page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(`${BASE}/notch.html?nw=180&nh=32&ew=40&xw=760&xh=500`, { waitUntil: "load" });
await page.waitForSelector(".notch-shell", { timeout: 15_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/01-collapsed.png`, animations: "disabled" });
// Hovering: the short list.
await page.evaluate(() => { window.gawkNotch.setMode("peek"); window.gawkNotch.setExpanded(true); });
await page.waitForSelector("[data-testid=notch-peek]", { timeout: 10_000 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/02-hover-list.png`, animations: "disabled" });
// The hotkey: Home, on the bot with a question.
await page.evaluate(() => { window.gawkNotch.setMode("home"); window.gawkNotch.setSize(760, 500); });
await page.waitForSelector("[data-testid=notch-home]", { timeout: 10_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/03-home-question.png`, animations: "disabled" });
await page.getByTestId("notch-row-suggestions").first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/04-home-suggestions.png`, animations: "disabled" });
await page.getByTestId("notch-row-designer").first().click();
await page.waitForSelector("[data-testid=notch-thread-designer]", { timeout: 10_000 });
await page.getByTestId("notch-compose-idle").click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/05-home-chat.png`, animations: "disabled" });
await page.getByTestId("notch-row-sessions").first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/06-home-sessions.png`, animations: "disabled" });
await page.getByRole("button", { name: "New bot" }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/07-new-bot.png`, animations: "disabled" });
await page.getByRole("button", { name: "Settings" }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/08-settings.png`, animations: "disabled" });
// The dock cards.
const dock = await context.newPage();
await dock.goto(`${BASE}/notch.html?dock=1`, { waitUntil: "load" });
await dock.waitForSelector("[data-testid=notch-dock]", { timeout: 15_000 });
await dock.waitForTimeout(700);
await dock.setViewportSize({ width: 320, height: 520 });
await dock.screenshot({ path: `${OUT}/05-dock.png`, animations: "disabled" });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
