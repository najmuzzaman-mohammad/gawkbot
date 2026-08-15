import { expect, type Page, test } from "@playwright/test";

import { APP_PANEL_IDS } from "../../src/routes/routeRegistry";
import {
  collectReactErrors,
  expectNoReactErrors,
  waitForReactMount,
} from "./_helpers";

// The operator surface is the ONLY front door (founder decision, 2026-08-14):
// every legacy office deep route — channels, tasks, wiki, app panels, the
// workbench — normalizes to /#/operator and mounts the operator shell. This
// matrix pins that: no route may strand a user in the retired office IA, and
// none may error while redirecting.

async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await waitForReactMount(page);
}

/** The route lands on the operator: hash normalized, operator root mounted,
 *  no not-found surface, no React errors on the way. */
async function expectOperatorLanding(page: Page, route: string): Promise<void> {
  const getErrors = collectReactErrors(page);
  await gotoRoute(page, route);
  await expect(page).toHaveURL(/#\/operator/, { timeout: 10_000 });
  await expect(page.getByTestId("operator-root")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("route-not-found")).toHaveCount(0);
  await expectNoReactErrors(page, getErrors, `while rendering ${route}`);
}

test.describe("canonical route matrix", () => {
  test("index renders the operator surface (the product front door)", async ({
    page,
  }) => {
    const getErrors = collectReactErrors(page);
    await gotoRoute(page, "/");
    // The index mounts the operator in place (no redirect) through the normal
    // boot + onboarding gate.
    await expect(page).toHaveURL(/localhost:\d+\/(#\/?)?$/);
    await expect(page.getByTestId("operator-root")).toBeVisible({
      timeout: 10_000,
    });
    await expectNoReactErrors(page, getErrors, "while rendering /");
  });

  test("the operator deep link mounts the operator shell", async ({ page }) => {
    await expectOperatorLanding(page, "/#/operator");
  });

  test("legacy conversation routes land on the operator", async ({ page }) => {
    await expectOperatorLanding(page, "/#/channels/general");
  });

  test("every legacy app panel route lands on the operator", async ({
    page,
  }) => {
    for (const appId of APP_PANEL_IDS) {
      await expectOperatorLanding(page, `/#/apps/${appId}`);
    }
  });

  test("legacy workbench and task URLs land on the operator", async ({
    page,
  }) => {
    await expectOperatorLanding(page, "/#/apps/workbench/pm/tasks/task-7");
    await expectOperatorLanding(page, "/#/tasks");
  });

  test("legacy wiki routes land on the operator", async ({ page }) => {
    await expectOperatorLanding(page, "/#/wiki");
    await expectOperatorLanding(page, "/#/wiki/lookup?q=renewal");
    await expectOperatorLanding(page, "/#/wiki/companies/acme");
  });

  test("dropped aliases and unknown routes land on the operator too", async ({
    page,
  }) => {
    // With the office retired there is no not-found surface to strand users
    // on — an unknown hash is just another retired path that normalizes home.
    for (const route of ["/#/console", "/#/threads", "/#/missing-route"]) {
      await expectOperatorLanding(page, route);
    }
  });
});
