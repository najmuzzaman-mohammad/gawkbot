import type { ComponentType } from "react";
import { composeStories } from "@storybook/react-vite";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as recordPageStories from "../record/RecordPage.stories";
import * as recordsPageStories from "./RecordsPage.stories";
import { resetMockClient } from "./testClient";

vi.mock("../../../api/dataspacesClient", async () =>
  (await import("./testClient")).mockClientModule(),
);

/**
 * Every story in records/ and record/ must mount and settle without
 * throwing. Stories are the visual spec for three themes; one that crashes
 * on a renamed fixture or a missing provider is a hole nobody sees until
 * someone opens Storybook.
 */
const modules = import.meta.glob<Record<string, unknown>>(
  ["./*.stories.tsx", "../record/*.stories.tsx"],
  { eager: true },
);

function isComponent(value: unknown): value is ComponentType {
  return typeof value === "function";
}

let exportedStoryCount = 0;
const composed: [label: string, Story: ComponentType][] = [];
for (const [path, module] of Object.entries(modules)) {
  const stories = composeStories(
    module as Parameters<typeof composeStories>[0],
  );
  for (const [name, Story] of Object.entries(stories)) {
    exportedStoryCount += 1;
    if (isComponent(Story)) composed.push([`${path} > ${name}`, Story]);
  }
}

beforeEach(() => {
  resetMockClient();
  window.localStorage.clear();
});

afterEach(cleanup);

describe("data records and record stories", () => {
  // A glob that matches nothing, or exports that stop being components,
  // would make the loop below pass by testing nothing. Pin the coverage.
  it("covers every story file and story", () => {
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(20);
    expect(composed.length).toBe(exportedStoryCount);
    expect(composed.length).toBeGreaterThanOrEqual(70);
  });

  // The loop below only proves stories do not throw. This proves the loop is
  // looking at real, data-backed screens rather than an empty shell.
  it("the page stories reach fixture data", async () => {
    const records = composeStories(recordsPageStories);
    const recordPage = composeStories(recordPageStories);
    const table = render(<records.Investors />);
    expect(
      await table.findByRole("link", { name: "Mirela Okonjo-Hart" }),
    ).toBeInTheDocument();
    cleanup();
    const page = render(<recordPage.Investor />);
    expect(
      await page.findByRole("heading", {
        level: 1,
        name: "Tobias Vandersloot",
      }),
    ).toBeInTheDocument();
  });

  for (const [label, Story] of composed) {
    it(`${label} renders`, async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const view = render(<Story />);
      await waitFor(() =>
        expect(view.baseElement.textContent).not.toContain("Loading fixtures"),
      );
      expect(view.baseElement.textContent).not.toContain("Fixture changed");
      const messages = errors.mock.calls.map((call) => String(call[0]));
      errors.mockRestore();
      expect(messages).toEqual([]);
    });
  }
});
