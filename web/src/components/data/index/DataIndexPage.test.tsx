import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataIndexPage } from "./DataIndexPage";
import { createTestClient, renderData } from "./dataTestKit";

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../../../api/dataspacesClient", () => ({
  get dataClient() {
    return holder.client;
  },
}));

beforeEach(() => {
  holder.client = null;
});

describe("<DataIndexPage>", () => {
  it("renders the Global group first, holding Company directory with its owner", async () => {
    holder.client = createTestClient();
    renderData(<DataIndexPage />);

    const global = await screen.findByTestId("data-global-group");
    expect(
      within(global).getByRole("heading", { level: 2, name: "Global" }),
    ).toBeInTheDocument();
    expect(
      within(global).getByText(
        "Every bot in the office reads and writes these.",
      ),
    ).toBeInTheDocument();
    expect(
      within(global).getByRole("link", { name: "Company directory" }),
    ).toHaveAttribute("href", "/data/space_company_directory");
    expect(within(global).getByText("Owned by")).toHaveTextContent("@cos");

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings[0]).toBe("Global");
    expect(headings.slice(1)).toEqual([
      expect.stringContaining("@cos"),
      expect.stringContaining("@ops"),
      expect.stringContaining("@recruiter"),
    ]);
  });

  it("lists each non-global space once, under its owner, with its access badge", async () => {
    holder.client = createTestClient();
    renderData(<DataIndexPage />);

    const cases = [
      ["cos", "Seed raise", "Private", "data-access-badge--private"],
      [
        "ops",
        "Client delivery",
        "Shared with @cos",
        "data-access-badge--shared",
      ],
      [
        "recruiter",
        "Recruiting",
        "Shared with @cos and @ops",
        "data-access-badge--shared",
      ],
    ] as const;
    for (const [owner, name, label, badgeClass] of cases) {
      const group = await screen.findByTestId(`data-bot-group-${owner}`);
      const row = within(group).getByRole("link", { name }).closest("tr");
      if (!row) throw new Error("row missing");
      expect(within(row).getByText(label)).toHaveClass(badgeClass);
      expect(
        within(group).getByRole("heading", { level: 2 }),
      ).toHaveTextContent("1 space");
      expect(screen.getAllByRole("link", { name })).toHaveLength(1);
    }
    // The global space is not repeated under its owner.
    expect(
      within(screen.getByTestId("data-bot-group-cos")).queryByRole("link", {
        name: "Company directory",
      }),
    ).toBeNull();
    expect(
      within(screen.getByTestId("data-global-group")).getByText("Global", {
        selector: ".data-access-badge",
      }),
    ).toHaveClass("data-access-badge--global");
  });

  it("counts the spaces shared with a bot instead of repeating them", async () => {
    holder.client = createTestClient();
    renderData(<DataIndexPage />);
    expect(
      within(await screen.findByTestId("data-bot-group-cos")).getByText(
        "Also has access to 2 shared spaces",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("data-bot-group-ops")).getByText(
        "Also has access to 1 shared space",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("data-bot-group-recruiter")).queryByText(
        /Also has access/,
      ),
    ).toBeNull();
  });

  it("shows counts for the seed raise space", async () => {
    const client = createTestClient();
    holder.client = client;
    const seed = (await client.listSpaces()).find(
      (space) => space.name === "Seed raise",
    );
    if (!seed) throw new Error("seed raise fixture missing");
    renderData(<DataIndexPage />);

    const link = await screen.findByRole("link", { name: "Seed raise" });
    const row = link.closest("tr");
    if (!row) throw new Error("row missing");
    const cells = within(row).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("Private");
    expect(cells[2]).toHaveTextContent(String(seed.objectTypeCount));
    expect(cells[3]).toHaveTextContent(seed.recordCount.toLocaleString());
    expect(cells[4]).toHaveTextContent(String(seed.attachedAppIds.length));
  });

  it("explains how spaces get created when there are none", async () => {
    holder.client = createTestClient({ spaces: [] });
    renderData(<DataIndexPage />);

    expect(
      await screen.findByRole("heading", { name: "No data spaces yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Track my seed raise/)).toBeInTheDocument();
    // Bots create spaces, so there is no create action in v1.
    expect(screen.queryByRole("button")).toBeNull();
  });
});
