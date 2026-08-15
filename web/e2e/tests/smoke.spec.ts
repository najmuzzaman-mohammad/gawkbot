import { expect, test } from "@playwright/test";

import { collectReactErrors, waitForReactMount } from "./_helpers";

// Boot smoke for the operator surface — the only front door since the office
// shell's retirement (founder decision, 2026-08-14). Guards the class of
// regression the old shell smoke guarded (a React render-time crash on first
// paint reaching users), pointed at the surface users actually land on.
//
// Assumes wuphf was started with ~/.wuphf/onboarded.json pre-seeded so the
// app lands in the operator rather than the onboarding wizard. Wizard
// coverage lives in local-llm-onboarding.spec.ts.

test.describe("wuphf web UI smoke (operator)", () => {
  test("first paint mounts the operator without tripping the error boundary", async ({
    page,
  }) => {
    const getErrors = collectReactErrors(page);

    await page.goto("/");
    await waitForReactMount(page);

    // The operator root appearing is our "React committed" signal.
    // networkidle does NOT work here — the shell opens long-lived streams.
    await expect(page.getByTestId("operator-root")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("error-boundary")).toHaveCount(0);

    const errors = getErrors();
    expect(
      errors,
      `React errors during operator boot:\n${errors.join("\n")}`,
    ).toEqual([]);
  });

  test("the agents surface and settings both render", async ({ page }) => {
    const getErrors = collectReactErrors(page);
    await page.goto("/#/operator");
    await waitForReactMount(page);
    await expect(page.getByTestId("operator-root")).toBeVisible({
      timeout: 10_000,
    });

    // Settings via the sidebar nav — the surface with the real Voice /
    // Usage / Runtime groups.
    await page.getByRole("button", { name: "Settings" }).first().click();
    await expect(page.getByText("Default runtime")).toBeVisible({
      timeout: 10_000,
    });

    // Back to Agents.
    await page.getByRole("button", { name: /^Agents/ }).first().click();
    await expect(page.getByText(/Your agents/i).first()).toBeVisible({
      timeout: 10_000,
    });

    const errors = getErrors();
    expect(
      errors,
      `React errors while switching surfaces:\n${errors.join("\n")}`,
    ).toEqual([]);
  });
});
