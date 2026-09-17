import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { DataSpacePage } from "./DataSpacePage";
import { createTestClient, renderData } from "./dataTestKit";

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../../../api/dataspacesClient", () => ({
  get dataClient() {
    return holder.client;
  },
}));

const SPACE = SEED_RAISE_SPACE_ID;

beforeEach(() => {
  holder.client = createTestClient();
});

describe("<DataSpacePage>", () => {
  it("lists the seed raise object types with their links", async () => {
    renderData(<DataSpacePage spaceId={SPACE} />, `/data/${SPACE}`);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Seed raise" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Owned by")).toHaveTextContent("@cos");

    const table = screen.getByRole("table");
    for (const [plural, slug] of [
      ["Investors", "investor"],
      ["Firms", "firm"],
      ["Meetings", "meeting"],
    ]) {
      expect(within(table).getByRole("link", { name: plural })).toHaveAttribute(
        "href",
        `/data/${SPACE}/t/${slug}`,
      );
      expect(
        within(table).getByRole("link", { name: `Settings for ${plural}` }),
      ).toHaveAttribute(
        "href",
        `/data/${SPACE}/t/${slug}/settings?tab=general`,
      );
      expect(
        within(table).getByRole("link", { name: `Open ${plural}` }),
      ).toHaveAttribute("href", `/data/${SPACE}/t/${slug}`);
    }
  });

  it("summarizes which types each type relates to", async () => {
    renderData(<DataSpacePage spaceId={SPACE} />, `/data/${SPACE}`);
    const investors = await screen.findByRole("link", { name: "Investors" });
    const row = investors.closest("tr");
    if (!row) throw new Error("row missing");
    expect(within(row).getByText("Firm, Meetings")).toBeInTheDocument();
  });

  it("renders one line per relationship with its mode and inverse", async () => {
    renderData(<DataSpacePage spaceId={SPACE} />, `/data/${SPACE}`);
    const section = await screen.findByRole("region", {
      name: "Relationships",
    });
    const lines = within(section).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent(
      "Investor . firm -> Firm(One Link per Source, many to one)inverse: investors",
    );
    expect(lines[1]).toHaveTextContent(
      "Meeting . investor -> Investor(One Link per Source, many to one)inverse: meetings",
    );
  });

  it("shows a not-found state with a way back for an unknown space", async () => {
    renderData(<DataSpacePage spaceId="space_nope" />, "/data/space_nope");
    expect(
      await screen.findByRole("heading", {
        name: "This data space does not exist",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Data" })).toHaveAttribute(
      "href",
      "/data",
    );
  });
});
