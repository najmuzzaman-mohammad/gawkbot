// Screenshots of the real desktop app for the website.
//
// The website shows the app as it is, not a drawing of it, so these images
// go stale the moment the UI changes. Re-run this after any visible change
// to the office UI and commit the result:
//
//   node scripts/website-app-shots.mjs
//
// It starts the web app's Vite dev server, serves a small demo office from
// mocked /api routes (no broker needed), and renders one frame per screen in
// both Glass flavours at 2x. The PNGs are re-encoded to WebP by the same
// Chromium, and written to website/<frame>-{light,dark}.webp:
//
//   app-glass        the Chief of Staff and the bots that report to it
//   app-team-2       the task board those bots are working from
//   app-routines-1   Scheduled Tasks, the list
//   app-routines-2   one routine's runs, the latest opened
//   app-wiki-1       the wiki, page tree opened out
//   app-wiki-2       one wiki article
//   app-apps-1       an app the bots built, running
//
// Every frame is the real UI, driven the way a person would drive it. Nothing
// is drawn into the page. The run fails if a page throws, or if a screen asks
// for an endpoint that has no mock (it would be showing an empty state).
//
// It also prints where each section's sidebar entry sits in each frame, as
// percentages of the image, for the website's highlight boxes.
//
// The demo office is the website's own cast (the bots in the hero and the
// sprite), with the same bodies and colours, and one story, shipping the
// checkout release, so the frames and the illustrations around them agree.
//
// Environment:
//   CHROMIUM_PATH  a Chromium to use. Unset, it uses /opt/pw-browsers/chromium
//                  when that exists, otherwise Playwright's own (install it
//                  with `cd web && bunx playwright install chromium`).
//   SHOTS_OUT      write somewhere other than website/, to look before keeping.
//   SHOTS_ONLY     comma-separated frame names, to render only those.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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

const APP_ID = "app_4c1f09d2a7b35e68";
const APPS = [
  {
    id: APP_ID,
    slug: "release-tracker",
    name: "Release tracker",
    icon: "",
    summary:
      "Every item in the checkout release, who owns it, and where it stands.",
    entry: "index.html",
    version: 3,
    status: "ready",
    createdBy: "cos",
    updatedBy: "cos",
    createdAt: minutesAgo(60 * 26),
    updatedAt: minutesAgo(18),
    contentHash: "9f2c41d7",
  },
];

// The page the bots built. It renders inside the app's sandboxed frame, so
// it carries its own styles. It is dark in both schemes because the app
// surface around it is: the app pins that surface dark whatever the theme.
const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Release tracker</title>
<style>
  :root { color-scheme: dark; --fg: #ececf0; --dim: #9a9aa6; --line: #2c2c33; --bg: #151518; --row: #1c1c21; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 32px; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, "Inter", "Segoe UI", sans-serif; }
  h1 { margin: 0 0 2px; font-size: 20px; font-weight: 650; }
  p.sub { margin: 0 0 20px; color: var(--dim); }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; }
  .stat { flex: 1; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--row); }
  .stat b { display: block; font-size: 22px; font-weight: 650; }
  .stat span { color: var(--dim); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; font-weight: 600; color: var(--dim); padding: 8px 10px; border-bottom: 1px solid var(--line); }
  td { padding: 10px; border-bottom: 1px solid var(--line); }
  td.owner { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .done { background: rgba(52, 168, 83, .16); color: #2f9e55; }
  .doing { background: rgba(66, 133, 244, .16); color: #4a8df6; }
  .wait { background: rgba(240, 160, 40, .18); color: #d58a12; }
  .todo { background: rgba(128, 128, 140, .18); color: var(--dim); }
</style>
</head>
<body>
  <h1>Checkout release</h1>
  <p class="sub">Target: Friday. 6 items, updated by the team as work lands.</p>
  <div class="stats">
    <div class="stat"><b>2</b><span>Shipped</span></div>
    <div class="stat"><b>2</b><span>In progress</span></div>
    <div class="stat"><b>1</b><span>Needs you</span></div>
    <div class="stat"><b>1</b><span>Not started</span></div>
  </div>
  <table>
    <thead><tr><th>Item</th><th>Owner</th><th>Status</th><th>Updated</th></tr></thead>
    <tbody>
      <tr><td>Split the release into tasks</td><td class="owner">cos</td><td><span class="pill done">Shipped</span></td><td>Mon</td></tr>
      <tr><td>Approve the sessions migration</td><td class="owner">you</td><td><span class="pill done">Shipped</span></td><td>Today</td></tr>
      <tr><td>Run the sessions migration on staging</td><td class="owner">auth-refactor</td><td><span class="pill doing">In progress</span></td><td>Today</td></tr>
      <tr><td>Draft the release notes</td><td class="owner">changelog</td><td><span class="pill doing">In progress</span></td><td>Today</td></tr>
      <tr><td>Make the checkout test deterministic</td><td class="owner">flaky-tests</td><td><span class="pill wait">Needs you</span></td><td>Today</td></tr>
      <tr><td>Update the pricing page for the new checkout</td><td class="owner">landing-copy</td><td><span class="pill todo">Not started</span></td><td>Tue</td></tr>
    </tbody>
  </table>
</body>
</html>`;

// ── Tasks: the checkout release, split three ways ─────────────────────
const task = (t) => ({
  task_type: "issue",
  created_by: "cos",
  channel: `task-${t.id.toLowerCase()}`,
  created_at: minutesAgo(41),
  ...t,
});
const TASKS = [
  task({
    id: "OFFICE-12",
    title: "Make the checkout test deterministic",
    description:
      "The checkout spec fails about one run in twelve. Find the cause and make it pass every time.",
    owner: "flaky-tests",
    status: "review",
    lifecycle_state: "decision",
    updated_at: minutesAgo(6),
  }),
  task({
    id: "OFFICE-13",
    title: "Run the sessions migration on staging",
    description:
      "Apply the sessions table migration on staging and confirm checkout sign-in still works.",
    owner: "auth-refactor",
    status: "in_progress",
    lifecycle_state: "running",
    updated_at: minutesAgo(3),
  }),
  task({
    id: "OFFICE-14",
    title: "Draft the checkout release notes",
    description:
      "Write the release notes for the checkout release from the merged work.",
    owner: "changelog",
    status: "open",
    lifecycle_state: "ready",
    depends_on: ["OFFICE-13"],
    updated_at: minutesAgo(40),
  }),
];
// ── Routines ──────────────────────────────────────────────────────────
// The next and the previous time the clock reads `hour`:00 on `weekday`
// (0 = Sunday; null = any day), so the schedule and the dates always agree.
const occurrence = (weekday, hour, direction) => {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  const step = direction * 86_400_000;
  const ok = () =>
    (weekday === null || d.getDay() === weekday) &&
    (direction > 0 ? d.getTime() > now : d.getTime() <= now);
  while (!ok()) d.setTime(d.getTime() + step);
  return d;
};
const MONDAY = 1;
const lastNotesRun = occurrence(MONDAY, 9, -1);
const WEEK_MS = 7 * 86_400_000;
const ROUTINE_SLUG = "weekly-release-notes";
const ROUTINES = [
  {
    slug: ROUTINE_SLUG,
    label: "Weekly release notes",
    kind: "routine",
    schedule_expr: "0 9 * * 1",
    interval_minutes: 0,
    target_type: "agent",
    target_id: "changelog",
    agent: "changelog",
    channel: "general",
    enabled: true,
    status: "scheduled",
    payload:
      "Read everything merged since last Monday, group it by area, and write the release notes to the wiki. Post a three-line summary when the page is up.",
    next_run: occurrence(MONDAY, 9, 1).toISOString(),
    last_run: lastNotesRun.toISOString(),
    last_run_status: "ok",
  },
  {
    slug: "nightly-flaky-test-sweep",
    label: "Nightly flaky-test sweep",
    kind: "routine",
    schedule_expr: "0 2 * * *",
    interval_minutes: 0,
    target_type: "agent",
    target_id: "flaky-tests",
    agent: "flaky-tests",
    channel: "general",
    enabled: true,
    status: "scheduled",
    payload:
      "Run the full suite three times, list every test that did not pass all three runs, and open a task for each new one.",
    next_run: occurrence(null, 2, 1).toISOString(),
    last_run: occurrence(null, 2, -1).toISOString(),
    last_run_status: "ok",
  },
  {
    slug: "weekday-morning-brief",
    label: "Weekday morning brief",
    kind: "routine",
    schedule_expr: "0 8 * * 1-5",
    interval_minutes: 0,
    target_type: "agent",
    target_id: "cos",
    agent: "cos",
    channel: "general",
    enabled: true,
    status: "scheduled",
    payload:
      "Summarise what each bot finished yesterday, what is in progress, and what is waiting on a human.",
    next_run: occurrence(null, 8, 1).toISOString(),
    last_run: occurrence(null, 8, -1).toISOString(),
    last_run_status: "ok",
  },
];
const notesRun = (weeksBack, summary, events) => {
  const started = lastNotesRun.getTime() - weeksBack * WEEK_MS;
  return {
    slug: ROUTINE_SLUG,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(started + 94_000 + weeksBack * 11_000).toISOString(),
    status: "ok",
    triggered_by: "schedule",
    target_type: "agent",
    target_id: "changelog",
    output_summary: summary,
    events,
  };
};
const ROUTINE_RUNS = [
  notesRun(0, "Wrote release notes for 14 merged changes.", [
    "Read 14 changes merged since last Monday",
    "Grouped them: checkout (6), sessions (5), tests (3)",
    "Wrote team/releases/release-notes.md",
    "Posted the summary",
  ]),
  notesRun(1, "Wrote release notes for 9 merged changes.", [
    "Read 9 changes merged since last Monday",
    "Grouped them: checkout (4), pricing page (3), tests (2)",
    "Wrote team/releases/release-notes.md",
    "Posted the summary",
  ]),
  notesRun(2, "Wrote release notes for 11 merged changes.", [
    "Read 11 changes merged since last Monday",
    "Grouped them: sessions (7), tests (4)",
    "Wrote team/releases/release-notes.md",
    "Posted the summary",
  ]),
  notesRun(3, "Nothing merged this week. No notes written.", [
    "Read 0 changes merged since last Monday",
    "Skipped the page; posted a one-line note instead",
  ]),
];

// ── Wiki ──────────────────────────────────────────────────────────────
const WIKI_ARTICLE_PATH = "team/projects/checkout-release.md";
const wikiPage = (dir, slug, title, author, minutes) => ({
  path: `team/${dir}/${slug}.md`,
  title,
  author_slug: author,
  last_edited_ts: minutesAgo(minutes),
  group: dir,
  categories: [dir],
  word_count: 240 + slug.length * 17,
  human_read_count: 2,
  agent_read_count: 5,
  days_unread: 0,
});
const WIKI_PAGES = [
  wikiPage("projects", "checkout-release", "Checkout release", "cos", 5),
  wikiPage(
    "projects",
    "pricing-page-rewrite",
    "Pricing page rewrite",
    "landing-copy",
    190,
  ),
  wikiPage(
    "decisions",
    "keep-the-clock-freeze",
    "Keep the clock freeze in checkout tests",
    "flaky-tests",
    4,
  ),
  wikiPage(
    "decisions",
    "sessions-migration-on-staging-first",
    "Sessions migration runs on staging first",
    "auth-refactor",
    30,
  ),
  wikiPage("playbooks", "ship-a-release", "Ship a release", "cos", 60 * 24 * 6),
  wikiPage(
    "playbooks",
    "fix-a-flaky-test",
    "Fix a flaky test",
    "flaky-tests",
    60 * 24 * 3,
  ),
  wikiPage(
    "releases",
    "release-notes",
    "Release notes",
    "changelog",
    60 * 24 * 2,
  ),
];
const WIKI_DIRS = [
  ["projects", "Projects"],
  ["decisions", "Decisions"],
  ["playbooks", "Playbooks"],
  ["releases", "Releases"],
];
const WIKI_TREE = WIKI_DIRS.map(([dir, title]) => ({
  name: dir,
  path: `team/${dir}`,
  type: "dir",
  title,
  children: WIKI_PAGES.filter((p) => p.group === dir).map((p) => ({
    name: p.path.split("/").pop(),
    path: p.path,
    type: "page",
    title: p.title,
    ext: ".md",
  })),
}));
const WIKI_SECTIONS = WIKI_DIRS.map(([dir, title]) => {
  const pages = WIKI_PAGES.filter((p) => p.group === dir);
  return {
    slug: dir,
    title,
    article_paths: pages.map((p) => p.path),
    article_count: pages.length,
    first_seen_ts: minutesAgo(60 * 24 * 20),
    last_update_ts: pages[0].last_edited_ts,
    from_schema: true,
  };
});
const WIKI_CATEGORIES = WIKI_SECTIONS.map((s) => ({
  slug: s.slug,
  title: s.title,
  article_count: s.article_count,
  parents: [],
}));
const WIKI_ARTICLE_BODY = `# Checkout release

The checkout release ships the new one-page checkout this week. The Chief of Staff split it into three tasks, one per bot, and keeps this page current as they report back.[^1]

## Where it stands

| Task | Owner | State |
| --- | --- | --- |
| Make the checkout test deterministic | flaky-tests | Two fixes ready, waiting on a choice |
| Run the sessions migration on staging | auth-refactor | Approved, running |
| Draft the release notes | changelog | Starts when the migration lands |

## What we decided

- The checkout test was failing about one run in twelve because it read the real clock. We keep the clock frozen in checkout tests.[^2] See [[decisions/keep-the-clock-freeze|Keep the clock freeze in checkout tests]].
- The sessions migration runs on staging before production, and a human approves it each time.[^3] See [[decisions/sessions-migration-on-staging-first|Sessions migration runs on staging first]].

## What is left

1. Pick one of the two test fixes.
2. Confirm sign-in on staging after the migration.
3. Publish the notes with [[playbooks/ship-a-release|Ship a release]].

[^1]: Chief of Staff, task plan for the checkout release, posted in the office chat.
[^2]: flaky-tests, run log for the checkout spec: 3 failures in 36 runs before the freeze, 0 in 36 after.
[^3]: Approval recorded on the task "Run the sessions migration on staging".
`;
const WIKI_ARTICLE = {
  path: WIKI_ARTICLE_PATH,
  title: "Checkout release",
  content: WIKI_ARTICLE_BODY,
  last_edited_by: "cos",
  last_edited_ts: minutesAgo(5),
  commit_sha: "a41c9e2",
  revisions: 4,
  contributors: ["cos", "flaky-tests", "auth-refactor"],
  backlinks: [
    {
      path: "team/releases/release-notes.md",
      title: "Release notes",
      author_slug: "changelog",
    },
    {
      path: "team/playbooks/ship-a-release.md",
      title: "Ship a release",
      author_slug: "cos",
    },
  ],
  word_count: 212,
  categories: ["projects"],
  human_read_count: 3,
  agent_read_count: 11,
  days_unread: 0,
  last_read: minutesAgo(2),
};
const WIKI_HISTORY = [
  ["a41c9e2", "cos", "Record the approved sessions migration", 5],
  ["7be03d1", "flaky-tests", "Add the clock-freeze finding and run counts", 9],
  ["52f8a6c", "auth-refactor", "Note the staging-first migration plan", 30],
  ["1d90b47", "cos", "Create the checkout release page from the task plan", 41],
].map(([sha, author_slug, msg, minutes]) => ({
  sha,
  author_slug,
  msg,
  date: minutesAgo(minutes),
}));
// The wiki's own recent-changes feed: the same commits, plus the latest on
// the pages around the article.
const WIKI_AUDIT = [
  [
    "e0b7d35",
    "flaky-tests",
    "Decide to keep the clock freeze",
    4,
    "decisions/keep-the-clock-freeze",
  ],
  ...WIKI_HISTORY.slice(0, 2).map((c) => [
    c.sha,
    c.author_slug,
    c.msg,
    (now - Date.parse(c.date)) / 60_000,
    "projects/checkout-release",
  ]),
  [
    "52f8a6c",
    "auth-refactor",
    "Write down why the migration runs on staging first",
    30,
    "decisions/sessions-migration-on-staging-first",
  ],
  [
    "c3a915f",
    "landing-copy",
    "Outline the pricing page rewrite",
    190,
    "projects/pricing-page-rewrite",
  ],
  [
    "48d2e0b",
    "changelog",
    "Publish this week's release notes",
    60 * 24 * 2,
    "releases/release-notes",
  ],
].map(([sha, author_slug, message, minutes, slug]) => ({
  sha,
  author_slug,
  timestamp: minutesAgo(minutes),
  message,
  paths: [`team/${slug}.md`],
}));

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

const notFound = (route) =>
  route.fulfill({ status: 404, contentType: "application/json", body: "{}" });

// Endpoints the demo office has nothing to say on. The app treats a 404 from
// each as "none" (no usage, no pending upgrade, no visual for the article),
// which is what these shots want. Anything else that reaches the catch-all is
// an endpoint a screen needs and nobody mocked: the run fails and names it.
const NOTHING_THERE = [
  "/api/commands",
  "/api/governor",
  "/api/office/stats",
  "/api/upgrade-check",
  "/api/usage",
  "/api/workspaces/list",
  "/api/article-attribution",
  "/api/wiki/visual",
];

async function mock(context, unmocked) {
  // Registered first so it loses: Playwright prefers the LAST matching route.
  await context.route(path("/api/**"), (r) => {
    const req = r.request();
    const { pathname } = new URL(req.url());
    if (!NOTHING_THERE.includes(pathname)) {
      unmocked.add(`${req.method()} ${pathname}`);
    }
    return notFound(r);
  });
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
  await context.route(path("/api/requests*"), (r) => json(r, { requests: [] }));

  // Tasks
  await context.route(path("/api/tasks*"), (r) => json(r, { tasks: TASKS }));
  await context.route(path("/api/inbox/items"), (r) =>
    json(r, { items: [], counts: {}, refreshedAt: minutesAgo(0) }),
  );

  // Routines
  await context.route(path("/api/scheduler"), (r) =>
    json(r, { jobs: ROUTINES }),
  );
  await context.route(path(`/api/scheduler/${ROUTINE_SLUG}/runs`), (r) =>
    json(r, { runs: ROUTINE_RUNS }),
  );

  // Wiki
  await context.route(path("/api/wiki/tree"), (r) =>
    json(r, { nodes: WIKI_TREE }),
  );
  await context.route(path("/api/wiki/catalog"), (r) =>
    json(r, { articles: WIKI_PAGES }),
  );
  await context.route(path("/api/wiki/sections"), (r) =>
    json(r, { sections: WIKI_SECTIONS }),
  );
  await context.route(path("/api/wiki/categories"), (r) =>
    json(r, { categories: WIKI_CATEGORIES }),
  );
  await context.route(path("/api/wiki/article"), (r) => {
    const asked = new URL(r.request().url()).searchParams.get("path");
    return asked === WIKI_ARTICLE_PATH ? json(r, WIKI_ARTICLE) : notFound(r);
  });
  await context.route(path("/api/wiki/audit"), (r) =>
    json(r, { entries: WIKI_AUDIT, total: WIKI_AUDIT.length }),
  );
  await context.route(path(`/api/wiki/history/${WIKI_ARTICLE_PATH}`), (r) =>
    json(r, { commits: WIKI_HISTORY }),
  );
  await context.route(path("/api/humans"), (r) =>
    json(r, { humans: [{ name: "You", email: "", slug: "you" }] }),
  );
  await context.route(path("/api/pam/actions"), (r) =>
    json(r, { actions: [] }),
  );

  // Apps
  await context.route(path("/api/apps"), (r) => json(r, { apps: APPS }));
  await context.route(path(`/api/apps/${APP_ID}`), (r) =>
    json(r, { app: APPS[0], html: APP_HTML, capabilities: {} }),
  );
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
const SCHEMES = [
  { theme: "nex-glass-light", scheme: "light" },
  { theme: "nex-glass-dark", scheme: "dark" },
];

// Each frame is one screen of the app. `prepare` drives the real UI (a click,
// a scroll) after the page has settled and before the picture is taken.
const FRAMES = [
  // The team: the Chief of Staff's page, then the board its tasks land on.
  { name: "app-glass", url: "/agents/cos" },
  {
    name: "app-team-2",
    url: "/tasks",
    // The routines lane is the routines frames' story; folding it lets the
    // three task lanes fit the width.
    prepare: (page) =>
      page.getByTestId("issues-kanban-column-toggle-scheduled").click(),
  },
  // Routines: the list, then one routine's run history with a run opened.
  { name: "app-routines-1", url: "/apps/routines" },
  {
    name: "app-routines-2",
    url: `/routines/${ROUTINE_SLUG}`,
    prepare: async (page) => {
      await page.getByTestId("routine-tab-runs").click();
      // The latest run opens by default; wait for its trace to be on screen.
      await page.getByTestId("routine-run-detail").waitFor();
    },
  },
  // The wiki: the page tree opened out, then one article.
  {
    name: "app-wiki-1",
    url: "/wiki",
    prepare: async (page) => {
      for (const [, title] of WIKI_DIRS) {
        await page.getByRole("button", { name: `Expand ${title}` }).click();
      }
    },
  },
  {
    name: "app-wiki-2",
    url: `/wiki/${WIKI_ARTICLE_PATH}`,
    // The tree had the last frame; fold it so the article has the width.
    prepare: (page) =>
      page.getByRole("button", { name: "Collapse Pages panel" }).click(),
  },
  // Apps: the tracker the bots built, running in the app.
  {
    name: "app-apps-1",
    url: `/apps/${APP_ID}`,
    // The Apps section sits below the fold of the sidebar at this height, so
    // scroll the sidebar to its end, with the wheel, as a person would.
    prepare: async (page) => {
      const box = await page.locator(".sidebar-scroll").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, box.height * 2);
      // Park the pointer off the sidebar so no row is drawn hovered.
      await page.mouse.move(VIEWPORT.width / 2, 4);
    },
  },
];

// Where each section's sidebar entry sits in the frame, as percentages of the
// image, for the website's highlight boxes. Measured, never estimated; null
// when the entry is scrolled out of the sidebar's view.
async function sidebarRects(page, viewport) {
  return page.evaluate(
    ({ width, height, appName }) => {
      const clip = document
        .querySelector(".sidebar-scroll")
        ?.getBoundingClientRect();
      const pct = (found) => {
        const boxes = found.filter(Boolean);
        if (boxes.length === 0 || !clip) return null;
        const left = Math.min(...boxes.map((b) => b.left));
        const right = Math.max(...boxes.map((b) => b.right));
        const top = Math.min(...boxes.map((b) => b.top));
        const bottom = Math.max(...boxes.map((b) => b.bottom));
        if (top < clip.top - 0.5 || bottom > clip.bottom + 0.5) return null;
        const r = (n) => Math.round(n * 100) / 100;
        return {
          x: r((left / width) * 100),
          y: r((top / height) * 100),
          w: r(((right - left) / width) * 100),
          h: r(((bottom - top) / height) * 100),
        };
      };
      const rect = (selector) =>
        document.querySelector(selector)?.getBoundingClientRect();
      const item = (label, scope = document) =>
        [...scope.querySelectorAll(".sidebar-item")]
          .find((el) => el.textContent.trim().startsWith(label))
          ?.getBoundingClientRect();
      const apps = document.querySelector(
        '[data-testid="sidebar-section-apps"]',
      );
      return {
        team: pct([
          rect(".sidebar-bot-group--ceo"),
          rect(".sidebar-bot-group--specialists"),
        ]),
        routines: pct([item("Scheduled Tasks")]),
        wiki: pct([item("Wiki")]),
        apps: pct([apps ? item(appName, apps) : undefined]),
      };
    },
    { ...viewport, appName: APPS[0].name },
  );
}

const OUT = process.env.SHOTS_OUT || join(ROOT, "website");
const ONLY = process.env.SHOTS_ONLY?.split(",");

function launchOptions() {
  if (process.env.CHROMIUM_PATH) {
    return { executablePath: process.env.CHROMIUM_PATH };
  }
  const preinstalled = "/opt/pw-browsers/chromium";
  return existsSync(preinstalled) ? { executablePath: preinstalled } : {};
}

const vite = await startVite();
const browser = await chromium.launch(launchOptions());
const errors = [];
const rects = {};
try {
  for (const shot of SCHEMES) {
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
    const unmocked = new Set();
    await mock(context, unmocked);
    for (const frame of FRAMES) {
      if (ONLY && !ONLY.includes(frame.name)) continue;
      const label = `${frame.name}-${shot.scheme}`;
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
      await page.goto(`${BASE}${frame.url}`, { waitUntil: "load" });
      await page.waitForTimeout(800);
      await page.evaluate(async () => {
        const m = await import("/src/stores/app.ts");
        m.useAppStore.setState({
          brokerConnected: true,
          onboardingComplete: true,
        });
      });
      await page.waitForTimeout(2000);
      if (frame.prepare) {
        await frame.prepare(page);
        await page.waitForTimeout(600);
      }
      rects[label] = await sidebarRects(page, VIEWPORT);
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
      const file = join(OUT, `${label}.webp`);
      writeFileSync(file, Buffer.from(webp, "base64"));
      console.log(`wrote ${file}`);
      await page.close();
      for (const request of unmocked) {
        errors.push(`${label}: no mock for ${request}`);
      }
      unmocked.clear();
    }
    await context.close();
  }
} finally {
  await browser.close();
  vite.kill();
}
console.log("sidebar entries, % of the frame:");
console.table(
  Object.fromEntries(
    Object.entries(rects).map(([label, r]) => [
      label,
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          v ? `${v.x} ${v.y} ${v.w} ${v.h}` : "not in view",
        ]),
      ),
    ]),
  ),
);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
