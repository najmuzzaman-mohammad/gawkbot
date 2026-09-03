import { expect, test } from "@playwright/test";

import { collectReactErrors, waitForReactMount } from "./_helpers";

// Boot smoke for the office shell — the front door again after the operator
// pivot was reversed. Guards the regression class this has always guarded: a
// React render-time crash on first paint reaching users, pointed at whichever
// surface users actually land on.
//
// This file previously smoked the operator ("the only front door since the
// office shell's retirement"). It asserted `operator-root`, which no longer
// exists in web/src at all.
//
// Assumes wuphf was started with <runtime home>/.wuphf/onboarded.json
// pre-seeded so the app lands in the office rather than the onboarding
// wizard. Wizard coverage lives in local-llm-onboarding.spec.ts.

test.describe("wuphf web UI smoke (office)", () => {
  test("first paint mounts the team without tripping the error boundary", async ({
    page,
  }) => {
    const getErrors = collectReactErrors(page);

    await page.goto("/");
    await waitForReactMount(page);

    // The task composer appearing is our "React committed" signal: the index
    // front door is the new-task composer, not a conversation. (`.composer-
    // input` is the CHANNEL composer and is absent here — asserting it fails
    // on a page that rendered fine, which is how this was first written.)
    // networkidle does NOT work here: the shell opens long-lived streams.
    await expect(page.getByTestId("task-composer-input")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("error-boundary")).toHaveCount(0);
    await expect(page.getByTestId("route-not-found")).toHaveCount(0);

    const errors = getErrors();
    expect(
      errors,
      `React errors during office boot:\n${errors.join("\n")}`,
    ).toEqual([]);
  });

  test("the sidebar renders its bot and app sections", async ({ page }) => {
    const getErrors = collectReactErrors(page);
    await page.goto("/");
    await waitForReactMount(page);

    // The sidebar is the office's navigation spine. Asserting the sections
    // rather than a specific bot or app keeps this smoke independent of
    // roster contents, which vary with seed state.
    await expect(page.getByTestId("sidebar-section-agents")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("sidebar-section-apps")).toBeVisible({
      timeout: 10_000,
    });

    const errors = getErrors();
    expect(
      errors,
      `React errors while rendering the sidebar:\n${errors.join("\n")}`,
    ).toEqual([]);
  });
});
