import { expect, test } from "@playwright/test";

import {
  collectReactErrors,
  expectNoReactErrors,
  waitForReactMount,
} from "./_helpers";

// The office app panels (Graph, Policies, Skills, Dashboard, …) were retired
// with the office shell: the operator surface is the only front door
// (founder decision, 2026-08-14), and every legacy /#/apps/<id> hash
// normalizes to /#/operator. Route-by-route operator coverage lives in
// route-matrix.spec.ts; this spec keeps the historical app ids pinned so a
// regression that resurrects the office panels (or breaks their redirect)
// fails loudly.

const LEGACY_APP_IDS = [
  "graph",
  "policies",
  "routines",
  "skills",
  "activity",
  "health-check",
  "integrations",
] as const;

test.describe("legacy app routes", () => {
  test("every retired app panel route lands on the operator", async ({
    page,
  }) => {
    const getErrors = collectReactErrors(page);

    for (const app of LEGACY_APP_IDS) {
      await page.goto(`/#/apps/${app}`);
      await waitForReactMount(page);
      await expect(page).toHaveURL(/#\/operator/, { timeout: 10_000 });
      await expect(page.getByTestId("operator-root")).toBeVisible({
        timeout: 10_000,
      });
      // The office panel must NOT mount on the way out.
      await expect(page.getByTestId(`app-page-${app}`)).toHaveCount(0);
      await expectNoReactErrors(page, getErrors, `while redirecting /${app}`);
    }
  });
});
