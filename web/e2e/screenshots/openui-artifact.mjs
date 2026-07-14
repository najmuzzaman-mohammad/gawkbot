import process from "node:process";

import {
  DEFAULT_BASE,
  flipStore,
  installCommonMocks,
  launchBrowser,
  shotPage,
} from "./lib.mjs";

const OUT = process.env.WUPHF_SCREENSHOTS_OUT;
if (!OUT) {
  console.error("WUPHF_SCREENSHOTS_OUT is not set; run via publish.sh");
  process.exit(2);
}

const ID = "ra_0123456789abcdef";
const detail = {
  artifact: {
    id: ID,
    kind: "notebook_openui",
    title: "Launch Readiness Review",
    summary: "A static, versioned OpenUI artifact rendered by WUPHF.",
    trustLevel: "draft",
    representation: "openui",
    contentPath: `wiki/visual-artifacts/${ID}.openui`,
    openuiVersion: "0.5",
    openuiLibrary: "wuphf-static-review",
    openuiLibraryHash:
      "f1224a608682fd95303ede0e1227a1e17d87bd7d646630081bd42674ffe1ee85",
    createdBy: "pm",
    createdAt: "2026-07-10T12:00:00Z",
    updatedAt: "2026-07-10T12:00:00Z",
    contentHash:
      "4b7f5f104f1cdd76e728be4a4d3fa49ed7d3d91c8dbba315f72494521c62a6a7",
    promotion: { status: "draft" },
  },
  openui: `root = Stack([title, decision, signals, risks], "l")
title = Heading("Launch Readiness Review", "1")
decision = Callout("Decision", "Proceed after the two blocking risks have owners and dates.", "warning")
signals = Section("Signals", [adoption, reliability, chart])
adoption = Metric("Pilot adoption", "74%", "Up 11 points week over week", "success")
reliability = Metric("Error budget", "81%", "Healthy, with room to improve", "info")
chart = BarChart("Readiness by lane", ["Product", "Support", "Security"], [88, 72, 64], "%")
risks = Section("Blocking risks", [riskList, nextStep])
riskList = List(["Complete the security review", "Publish the support escalation playbook"], true)
nextStep = Text("Next review: Friday at 10:00 AM with owners present.", "muted")`,
};

const { browser, context, page, errors } = await launchBrowser({
  viewport: { width: 1400, height: 1000 },
});

await installCommonMocks(context, {
  extra: async (ctx) => {
    await ctx.route(`**/api/visual-artifacts/${ID}*`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detail),
      }),
    );
    await ctx.route("**/api/article-attribution*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ attribution: null }),
      }),
    );
  },
});

await page.goto(`${DEFAULT_BASE}/#/articles/${ID}`, { waitUntil: "load" });
await page.waitForSelector(".status-bar", { timeout: 15_000 });
await flipStore(page);
await page.waitForSelector(".openui-artifact-renderer", { timeout: 10_000 });

for (const [theme, name] of [
  ["nex", "01-openui-nex-light"],
  ["nex-dark", "02-openui-nex-dark"],
  ["noir-gold", "03-openui-noir-gold"],
]) {
  await page.evaluate(async (themeId) => {
    const store = await import("/src/stores/app.ts");
    store.useAppStore.getState().setTheme(themeId);
  }, theme);
  await page.waitForTimeout(300);
  await shotPage(page, OUT, name);
}

if (errors.length > 0) {
  throw new Error(`browser errors:\n${errors.join("\n")}`);
}

console.log(`captured 3 OpenUI artifact screenshots to ${OUT}`);
await browser.close();
