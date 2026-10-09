// Screenshots of the real desktop app for the website.
//
// The website shows the app as it is, not a drawing of it, so these images
// go stale the moment the UI changes. Re-run this after any visible change
// to the office UI and commit the result:
//
//   node scripts/website-app-shots.mjs
//
// It starts the web app's Vite dev server, serves a small demo team from
// mocked /api routes (no broker needed), and renders the Chief of Staff's
// page in both Glass flavours at 2x. The PNGs are re-encoded to WebP by the
// same Chromium, and written to website/app-glass-{light,dark}.webp.
//
// The demo team is the website's own cast (the bots in the hero and the
// sprite), with the same bodies and colours, so the app shot and the
// illustrations around it agree.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");
const { chromium } = await import(
  join(WEB, "node_modules/playwright/index.mjs")
);

const PORT = 5397;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 2;
const QUALITY = 0.9;

// ── The demo team ─────────────────────────────────────────────────────
const MEMBERS = [
  {
    slug: "cos",
    name: "Chief of Staff",
    role: "Lead agent",
    built_in: true,
    online: true,
    provider: "claude-code",
    task: "Watching the checkout release",
  },
  {
    slug: "auth-refactor",
    name: "auth-refactor",
    role: "Backend",
    online: true,
    provider: "claude-code",
    status: "active",
    task: "Waiting on your approval",
    avatar: { shape: "lemon", color: "#ff6b8b" },
  },
  {
    slug: "flaky-tests",
    name: "flaky-tests",
    role: "Testing",
    online: true,
    provider: "codex",
    status: "active",
    task: "Two fixes ready",
    avatar: { shape: "ghost", color: "#3cc3df" },
  },
  {
    slug: "landing-copy",
    name: "landing-copy",
    role: "Marketing",
    online: true,
    provider: "claude-code",
    task: "Rewriting the pricing page",
    avatar: { shape: "drop", color: "#ffa53d" },
  },
  {
    slug: "changelog",
    name: "changelog",
    role: "Release notes",
    online: true,
    provider: "opencode",
    task: "Drafting the release notes",
    avatar: { shape: "seacow", color: "#9ad44e" },
  },
];

const now = Date.now();
const minutesAgo = (m) => new Date(now - m * 60_000).toISOString();
const MESSAGES = [
  {
    id: "m1",
    from: "human",
    channel: "general",
    content: "Get the checkout release out this week.",
    timestamp: minutesAgo(42),
  },
  {
    id: "m2",
    from: "cos",
    channel: "general",
    content:
      "On it. I split it into three tasks: **flaky-tests** makes the checkout test deterministic, **auth-refactor** runs the sessions migration on staging, and **changelog** drafts the notes. I'll come to the notch when someone needs a yes.",
    timestamp: minutesAgo(41),
  },
  {
    id: "m3",
    from: "cos",
    channel: "general",
    content:
      "flaky-tests has two fixes ready and auth-refactor is waiting on your approval for the migration. Both questions are in your notch.",
    timestamp: minutesAgo(6),
  },
  {
    id: "m4",
    from: "human",
    channel: "general",
    content: "Approved the migration. Keep the clock freeze.",
    timestamp: minutesAgo(3),
  },
];

const APPS = [
  {
    id: "release-tracker",
    slug: "release-tracker",
    name: "Release tracker",
    icon: "",
    entry: "index.html",
    version: 3,
    status: "ready",
  },
];

// ── Mocked API ────────────────────────────────────────────────────────
const json = (route, body) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(body),
  });

// Match on the request path, never a glob: "**/api/**" also matches the
// app's own /src/api/*.ts modules and would serve JSON in place of them.
const path = (pattern) => {
  const re = new RegExp(
    `^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`,
  );
  return (url) => re.test(new URL(url).pathname);
};

async function mock(context) {
  // Registered first so it loses: Playwright prefers the LAST matching route.
  await context.route(path("/api/**"), (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route(path("/api-token"), (r) =>
    json(r, { token: "demo", broker_url: null }),
  );
  await context.route(path("/web-token"), (r) => json(r, { token: "demo" }));
  await context.route(path("/api/onboarding/state"), (r) =>
    json(r, { onboarded: true }),
  );
  await context.route(path("/api/health"), (r) =>
    json(r, {
      status: "ok",
      session_mode: "office",
      provider: "claude-code",
      memory_backend: "local",
      // The version the website's download currently ships.
      build: { version: "0.239.0", build_timestamp: "" },
    }),
  );
  await context.route(path("/api/humans/me"), (r) =>
    json(r, { human: { slug: "you", name: "You" } }),
  );
  await context.route(path("/api/office-members"), (r) =>
    json(r, { members: MEMBERS, meta: { humanHasPosted: true } }),
  );
  await context.route(path("/api/members*"), (r) =>
    json(r, { members: MEMBERS }),
  );
  await context.route(path("/api/channels"), (r) => json(r, { channels: [] }));
  await context.route(path("/api/messages*"), (r) =>
    json(r, { messages: MESSAGES }),
  );
  await context.route(path("/api/apps"), (r) => json(r, { apps: APPS }));
  await context.route(path("/api/requests*"), (r) => json(r, { requests: [] }));
  await context.route(path("/api/tasks*"), (r) => json(r, { tasks: [] }));
  await context.route(path("/api/config"), (r) =>
    json(r, { llm_provider: "claude-code", memory_backend: "local" }),
  );
  // The event stream never answers, so nothing live disturbs the shot.
  await context.route(path("/api/events*"), () => new Promise(() => {}));
}

// ── Dev server ────────────────────────────────────────────────────────
async function startVite() {
  const vite = spawn(
    "bunx",
    ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB, stdio: ["ignore", "pipe", "pipe"] },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return vite;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  vite.kill();
  throw new Error(`vite did not come up on ${BASE}`);
}

// ── Shots ─────────────────────────────────────────────────────────────
const SHOTS = [
  { theme: "nex-glass-light", scheme: "light", out: "app-glass-light.webp" },
  { theme: "nex-glass-dark", scheme: "dark", out: "app-glass-dark.webp" },
];

const vite = await startVite();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
});
const errors = [];
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: shot.scheme,
    });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem("wuphf-theme", t);
      } catch {
        // the store falls back to the system default
      }
    }, shot.theme);
    await mock(context);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${shot.theme}: ${e.message}`));
    await page.goto(`${BASE}/agents/cos`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await page.evaluate(async () => {
      const m = await import("/src/stores/app.ts");
      m.useAppStore.setState({
        brokerConnected: true,
        onboardingComplete: true,
      });
    });
    await page.waitForTimeout(2000);
    const png = await page.screenshot({ animations: "disabled" });
    // Re-encode in the page: Chromium writes WebP, and nothing else needs
    // installing.
    const webp = await page.evaluate(
      async ({ b64, quality }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        return canvas.toDataURL("image/webp", quality).split(",")[1];
      },
      { b64: png.toString("base64"), quality: QUALITY },
    );
    const file = join(ROOT, "website", shot.out);
    writeFileSync(file, Buffer.from(webp, "base64"));
    console.log(`wrote ${file}`);
    await context.close();
  }
} finally {
  await browser.close();
  vite.kill();
}
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
