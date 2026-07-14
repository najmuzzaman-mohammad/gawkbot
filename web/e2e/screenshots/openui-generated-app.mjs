import { DEFAULT_BASE, launchBrowser, shotElement, shotPage } from "./lib.mjs";
import process from "node:process";

const OUT = process.env.WUPHF_SCREENSHOTS_OUT;
if (!OUT) {
  console.error("WUPHF_SCREENSHOTS_OUT is not set; run via publish.sh");
  process.exit(2);
}

const ID = "app_69cebd17418462a4";
const APP = {
  id: ID,
  slug: "reporting-agent",
  name: "Reporting Agent",
  icon: "📊",
  summary: "Live task operations dashboard",
  description:
    "Task Control shows live task metrics and an operations table backed by the workspace.",
  entry: "app.openui",
  representation: "openui",
  openuiVersion: "0.5",
  openuiLibrary: "wuphf-app-v1",
  openuiLibraryHash:
    "06e4b7ef3e2e2ca65a3cbe9b966d502210270331b475c21ab99ad5e90d51489e",
  providerVersion: "1",
  version: 1,
  status: "ready",
  editChannel: "task-office-1",
  createdBy: "human",
  updatedBy: "app-builder",
  createdAt: "2026-07-11T03:34:40Z",
  updatedAt: "2026-07-11T03:35:13Z",
  contentHash:
    "656a20da85fd6c5a9c0fc7f4fdd1b1c4516e2b7cadfb55f03279bda62c7dc6ee",
};

const OPENUI = `root = App("Task Control", [intro, metricsCard, tasksCard])
tasks = Query("wuphf_list_tasks", {}, [])
intro = Callout("Live task operations across the office. Counts and rows refresh from the current task list.", "info")
metricsCard = Card("Task metrics", [openMetric, activeMetric, doneMetric])
openMetric = Metric("Open", @Count(@Filter(tasks, "status", "==", "open")), "Ready to start", "warning")
activeMetric = Metric("In progress", @Count(@Filter(tasks, "status", "==", "in_progress")), "Currently underway", "info")
doneMetric = Metric("Completed", @Count(@Filter(tasks, "status", "==", "completed")), "Finished work", "success")
tasksCard = Card("Operations", [tasksTable])
tasksTable = DataTable([{"label":"Task","key":"title"},{"label":"Owner","key":"owner"},{"label":"Status","key":"status"},{"label":"Priority","key":"priority"}], tasks, "No tasks are available.")`;

const TASKS = [
  {
    id: "OFFICE-18",
    title: "Prepare customer launch brief",
    owner: "operator",
    status: "open",
    priority: "High",
  },
  {
    id: "OFFICE-19",
    title: "Review support escalation gaps",
    owner: "support",
    status: "in_progress",
    priority: "Medium",
  },
  {
    id: "OFFICE-17",
    title: "Publish weekly operations digest",
    owner: "app-builder",
    status: "completed",
    priority: "Low",
  },
];

const { browser, context, page, errors } = await launchBrowser({
  viewport: { width: 1440, height: 1000 },
});

await context.route(/\/api\/apps(?:\/.*)?(?:\?.*)?$/, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === `/api/apps/${ID}`) {
    const json = url.searchParams.has("source")
      ? { capabilities: {} }
      : { app: APP, openui: OPENUI };
    return route.fulfill({ json });
  }
  if (url.pathname === "/api/apps") {
    return route.fulfill({ json: { apps: [APP] } });
  }
  return route.fulfill({ json: {} });
});
await context.route(/\/api\/tasks(?:\?.*)?$/, (route) =>
  route.fulfill({ json: { channel: "", tasks: TASKS } }),
);
await context.route(/\/api\/requests(?:\?.*)?$/, (route) =>
  route.fulfill({ json: { requests: [] } }),
);
await context.route(/\/agent\/.+/, (route) =>
  route.fulfill({ json: { tools: [], artifacts: [] } }),
);
await context.route("**/api-token", (route) =>
  route.fulfill({ json: { token: "screenshot-token", broker_url: null } }),
);
await context.route("**/web-token", (route) =>
  route.fulfill({ json: { token: "screenshot-token" } }),
);

await page.goto(`${DEFAULT_BASE}/?token=screenshot-token#/operator`, {
  waitUntil: "load",
});
try {
  await page.waitForSelector(".opr-sidebar", { timeout: 15_000 });
} catch (error) {
  console.error(`operator boot failed at ${page.url()}`);
  console.error((await page.locator("body").innerText()).slice(0, 2_000));
  console.error(errors.join("\n"));
  throw error;
}
await page
  .locator(".opr-agent-rail-item", { hasText: "Reporting Agent" })
  .click();
try {
  await page.waitForSelector('[data-testid="openui-app-renderer"]', {
    timeout: 10_000,
  });
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(0, 2_000));
  console.error(errors.join("\n"));
  throw error;
}
await page.getByText("Prepare customer launch brief").waitFor();

await shotPage(page, OUT, "01-openui-generated-agent");
await shotElement(
  page,
  '[data-testid="openui-app-renderer"]',
  OUT,
  "02-openui-generated-app",
);

if (errors.length > 0) {
  throw new Error(`browser errors:\n${errors.join("\n")}`);
}

console.log(`captured 2 generated OpenUI app screenshots to ${OUT}`);
await browser.close();
