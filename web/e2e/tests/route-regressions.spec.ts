import { expect, test } from "@playwright/test";

import {
  collectReactErrors,
  expectNoReactErrors,
  resetBroker,
  waitForReactMount,
} from "./_helpers";

// Regression pins for the office-shell retirement (founder decision,
// 2026-08-14): the operator surface is the only front door, and every legacy
// office hash normalizes to /#/operator. The office-era pins this file used
// to hold (Console/Threads unknown-app fallbacks, the /apps/requests → /tasks
// redirect, ThreadPanel channel latching, StatusBar/wiki title parity, the
// NotFoundSurface affordance) all asserted surfaces that no longer mount —
// their modern equivalent is one property: NO legacy route may resurrect an
// office panel, and none may error on the way to the operator.
//
// Broad route → operator coverage lives in route-matrix.spec.ts and
// app-routes.spec.ts; this file pins the specific ids whose office panels
// were individually retired (#1055 console, threads, requests) so a revert
// that re-adds one to the panel registry fails with a named test.

test.afterEach(async ({ request }) => {
  await resetBroker(request);
});

test.describe("office-shell retirement pins", () => {
  for (const legacy of ["console", "threads", "requests"] as const) {
    test(`/apps/${legacy} lands on the operator and never re-mounts its panel`, async ({
      page,
    }) => {
      const getErrors = collectReactErrors(page);
      await page.goto(`/#/apps/${legacy}`);
      await waitForReactMount(page);
      await expect(page).toHaveURL(/#\/operator/, { timeout: 10_000 });
      await expect(page.getByTestId("operator-root")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId(`app-page-${legacy}`)).toHaveCount(0);
      await expectNoReactErrors(page, getErrors, `retired /apps/${legacy}`);
    });
  }

  test("a conversation deep link lands on the operator with no office chrome", async ({
    page,
  }) => {
    const getErrors = collectReactErrors(page);
    await page.goto("/#/channels/general");
    await waitForReactMount(page);
    await expect(page).toHaveURL(/#\/operator/, { timeout: 10_000 });
    // Office shell chrome must not flash in: no office sidebar, no composer.
    await expect(page.locator("aside.sidebar")).toHaveCount(0);
    await expect(page.locator(".composer-input")).toHaveCount(0);
    await expectNoReactErrors(page, getErrors, "retired conversation route");
  });
});
