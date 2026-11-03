import { expect, type Page, test } from "@playwright/test";

import { APP_PANEL_IDS } from "../../src/routes/routeRegistry";
import {
  collectReactErrors,
  expectNoReactErrors,
  waitForReactMount,
} from "./_helpers";

// The office shell is the front door again. This file previously pinned the
// exact opposite — "the operator surface is the ONLY front door (founder
// decision, 2026-08-14)" — and asserted that every office route normalized to
// /#/operator. That decision was reversed: the office IA is the product, and
// `operator-root` no longer exists anywhere in web/src, which is why every
// assertion here failed with "element(s) not found".
//
// Worth being precise about what was wrong, because the tests were not buggy:
// they were correct pins on a superseded product. A test that fails because
// the product deliberately changed direction is doing its job; it just has to
// be re-aimed rather than repaired. These are re-aimed at the office.
//
// The office-era matrix (pre-5027ec625) is the ancestor of this file and most
// of its shape is restored verbatim, because the contract it pinned is the
// contract again.

async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await waitForReactMount(page);
}

/** The route reaches its own surface: no not-found, the expected surface
 *  mounted, and no React error on the way. */
async function expectCanonicalRoute(
  page: Page,
  route: string,
  assertMounted: (targetPage: Page) => Promise<void>,
): Promise<void> {
  const getErrors = collectReactErrors(page);
  await gotoRoute(page, route);
  await expect(page.getByTestId("route-not-found")).toHaveCount(0);
  await assertMounted(page);
  await expectNoReactErrors(page, getErrors, `while rendering ${route}`);
}

test.describe("canonical route matrix", () => {
  test("index mounts the team shell (the product front door)", async ({
    page,
  }) => {
    const getErrors = collectReactErrors(page);
    await gotoRoute(page, "/");

    // The index mounts in place through the normal boot + onboarding gate —
    // no redirect, so the URL stays bare.
    //
    // The front door is the TASK COMPOSER ("Describe the outcome. The team
    // starts on it immediately"), not a conversation. Worth stating because
    // the obvious guess is wrong: `.composer-input` is the CHANNEL composer
    // and it is absent here, so asserting it fails on a page that is
    // rendering perfectly well.
    await expect(page).toHaveURL(/localhost:\d+\/(#\/?)?$/);
    await expect(page.getByTestId("task-composer-input")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("route-not-found")).toHaveCount(0);
    await expectNoReactErrors(page, getErrors, "while rendering /");
  });

  test("every registered app panel route mounts its own panel", async ({
    page,
  }) => {
    // The inverse of the retired pin. This spec's predecessor asserted these
    // panels must NOT mount ("a regression that resurrects the team panels
    // fails loudly"). They were resurrected on purpose, so mounting is now
    // the contract and a redirect would be the regression.
    for (const appId of APP_PANEL_IDS) {
      // /#/apps/requests folds into the Task board's Needs-human lane rather
      // than rendering a panel of its own, so it is pinned by URL.
      if (appId === "requests") {
        await page.goto(`/#/apps/${appId}`);
        await expect(page).toHaveURL(/#\/tasks$/, { timeout: 10_000 });
        continue;
      }
      await expectCanonicalRoute(page, `/#/apps/${appId}`, async (p) => {
        await expect(p.getByTestId(`app-page-${appId}`)).toBeVisible({
          timeout: 10_000,
        });
      });
    }
  });

  test("the task board mounts", async ({ page }) => {
    await expectCanonicalRoute(page, "/#/tasks", async (p) => {
      await expect(p.getByTestId("route-not-found")).toHaveCount(0);
      await expect(p.locator("body")).toBeVisible();
    });
  });

  test("legacy workbench URLs redirect through to the Tasks surface", async ({
    page,
  }) => {
    const getErrors = collectReactErrors(page);
    await gotoRoute(page, "/#/apps/workbench/pm/tasks/task-7");

    // workbench -> legacy task redirect -> /tasks/$id detail (see
    // legacyWorkbenchTaskRoute in lib/router.ts).
    await expect(page).toHaveURL(/#\/tasks/, { timeout: 10_000 });
    await expect(page.getByTestId("route-not-found")).toHaveCount(0);
    await expectNoReactErrors(
      page,
      getErrors,
      "while redirecting legacy workbench task route",
    );
  });

  test("wiki routes mount their first-class surfaces", async ({ page }) => {
    await expectCanonicalRoute(page, "/#/wiki", async (p) => {
      await expect(p.getByTestId("wiki-root")).toBeVisible({ timeout: 10_000 });
    });

    await expectCanonicalRoute(page, "/#/wiki/companies/acme", async (p) => {
      await expect(p.getByTestId("wiki-root")).toBeVisible({ timeout: 10_000 });
    });
  });

  test("data routes mount the Data section", async ({ page }) => {
    // The Data section used to render from fixtures, so this route could not
    // fail on anything but the router. It now talks to the broker's
    // /data/spaces routes, which is exactly why it belongs in the matrix: a
    // client that throws on mount, or a route the broker answers 404 to,
    // shows up here as a React error rather than as a quietly empty page.
    //
    // The assertion is deliberately the SECTION, not a space or a table. What
    // is in the store depends on what the bots have built, so pinning a
    // fixture's space id would make this spec fail for a reason that has
    // nothing to do with routing.
    await expectCanonicalRoute(page, "/#/data", async (p) => {
      await expect(p.getByTestId("data-section")).toBeVisible({
        timeout: 10_000,
      });
    });

    // A space id that is not there must still reach the section and render its
    // own not-found affordance — never the router's, and never a blank page.
    await expectCanonicalRoute(page, "/#/data/space_missing", async (p) => {
      await expect(p.getByTestId("data-section")).toBeVisible({
        timeout: 10_000,
      });
    });
  });

  test("unknown routes render the not-found surface", async ({ page }) => {
    // The other half of the reversal. With the office retired there was no
    // not-found surface at all — every unknown hash "normalized home", so a
    // typo silently landed the user somewhere plausible. The office has a
    // real not-found affordance and an unknown route must reach it rather
    // than being quietly absorbed.
    for (const route of ["/#/missing-route", "/#/not-a-surface"]) {
      const getErrors = collectReactErrors(page);
      await gotoRoute(page, route);
      await expect(page.getByTestId("route-not-found")).toBeVisible({
        timeout: 10_000,
      });
      await expectNoReactErrors(page, getErrors, `while rendering ${route}`);
    }
  });
});
