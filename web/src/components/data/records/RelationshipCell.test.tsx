import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { resetMockClient } from "./testClient";
import { renderDataRoute } from "./testKit";
import { humanizeLinkError } from "./useRelationshipEdit";

vi.mock("../../../api/dataspacesClient", async () =>
  (await import("./testClient")).mockClientModule(),
);

const INVESTORS = `/data/${SEED_RAISE_SPACE_ID}/t/investor`;
const FIRMS = `/data/${SEED_RAISE_SPACE_ID}/t/firm`;

beforeEach(() => {
  resetMockClient();
  window.localStorage.clear();
});

function rowFor(name: string): HTMLElement {
  const row = screen
    .getAllByTestId("data-record-row")
    .find((item) => item.querySelector(".dr-name-link")?.textContent === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

/** Chips in the row's FIRST relationship column (Firm, or Investors). */
function chipNames(row: HTMLElement): string[] {
  const cell = row.querySelector(".dr-rel-cell");
  return [...(cell?.querySelectorAll(".dr-chip-link") ?? [])].map(
    (chip) => chip.textContent ?? "",
  );
}

describe("humanizeLinkError", () => {
  it("drops the instruction written for bots and keeps the explanation", () => {
    expect(
      humanizeLinkError(
        "Anneke is already linked to Halcyon, and each Investor can belong to one Firm through Investors. Pass replace to move it to Tidewrack.",
      ),
    ).toBe(
      "Anneke is already linked to Halcyon, and each Investor can belong to one Firm through Investors.",
    );
    expect(humanizeLinkError("Unknown record.")).toBe("Unknown record.");
    expect(humanizeLinkError("")).toBe("That link could not be changed.");
  });
});

describe("<RelationshipCell>", () => {
  it("links a record picked from the searched target type", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    const row = rowFor("Wilhelmina Storrs");
    expect(chipNames(row)).toEqual([]);
    await user.click(
      within(row).getByRole("button", {
        name: "Link Firm to Wilhelmina Storrs",
      }),
    );
    const picker = await screen.findByTestId("data-record-picker");
    await user.type(
      within(picker).getByRole("combobox", { name: "Search firms" }),
      "Tide",
    );
    await user.click(
      await within(picker).findByRole("option", { name: "Tidewrack Capital" }),
    );
    await waitFor(() =>
      expect(chipNames(rowFor("Wilhelmina Storrs"))).toEqual([
        "Tidewrack Capital",
      ]),
    );
    // A successful link closes the picker.
    await waitFor(() =>
      expect(screen.queryByTestId("data-record-picker")).toBeNull(),
    );
    const chip = within(rowFor("Wilhelmina Storrs")).getByRole("link", {
      name: "Tidewrack Capital",
    });
    expect(chip.getAttribute("href")).toContain(
      `/data/${SEED_RAISE_SPACE_ID}/r/`,
    );
  });

  it("picks with the keyboard: arrows move, Enter links", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    await user.click(
      within(rowFor("Leilani Kahananui")).getByRole("button", {
        name: "Link Firm to Leilani Kahananui",
      }),
    );
    const picker = await screen.findByTestId("data-record-picker");
    const input = within(picker).getByRole("combobox", {
      name: "Search firms",
    });
    const options = await within(picker).findAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    input.focus();
    await user.keyboard("{ArrowDown}");
    const [, second] = within(picker).getAllByRole("option");
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input.getAttribute("aria-activedescendant")).toBe(second.id);
    const expectedName = second.textContent ?? "";
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(chipNames(rowFor("Leilani Kahananui"))).toEqual([expectedName]),
    );
  });

  it("unlinks from the chip", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    await user.click(
      within(rowFor("Mirela Okonjo-Hart")).getByRole("button", {
        name: "Unlink Tidewrack Capital from Mirela Okonjo-Hart",
      }),
    );
    await waitFor(() =>
      expect(
        within(rowFor("Mirela Okonjo-Hart")).queryByRole("link", {
          name: "Tidewrack Capital",
        }),
      ).toBeNull(),
    );
  });

  it("a to-one attribute replaces its link instead of adding a second", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    const row = rowFor("Mirela Okonjo-Hart");
    await user.click(
      within(row).getByRole("button", {
        name: "Link Firm to Mirela Okonjo-Hart",
      }),
    );
    const picker = await screen.findByTestId("data-record-picker");
    // The firm already linked is not offered again.
    await within(picker).findAllByRole("option");
    expect(
      within(picker).queryByRole("option", { name: "Tidewrack Capital" }),
    ).toBeNull();
    await user.click(
      within(picker).getByRole("option", { name: "Halcyon Spur Ventures" }),
    );
    await waitFor(() =>
      expect(chipNames(rowFor("Mirela Okonjo-Hart"))).toEqual([
        "Halcyon Spur Ventures",
      ]),
    );
  });

  it("when the other side is to-one and taken, it explains and offers Move it here", async () => {
    const { user } = renderDataRoute(FIRMS);
    await screen.findByTestId("data-records-table");
    const row = rowFor("Tidewrack Capital");
    await user.click(
      within(row).getByRole("button", {
        name: "Link Investors to Tidewrack Capital",
      }),
    );
    const picker = await screen.findByTestId("data-record-picker");
    await user.type(
      within(picker).getByRole("combobox", { name: "Search investors" }),
      "Anneke",
    );
    await user.click(
      await within(picker).findByRole("option", { name: "Anneke Brightwater" }),
    );
    const alert = await within(picker).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Anneke Brightwater is already linked to Halcyon Spur Ventures",
    );
    expect(alert).not.toHaveTextContent("Pass replace");
    expect(chipNames(rowFor("Tidewrack Capital"))).not.toContain(
      "Anneke Brightwater",
    );

    await user.click(
      within(alert).getByRole("button", { name: "Move it here" }),
    );
    await waitFor(() =>
      expect(
        within(rowFor("Tidewrack Capital")).getByRole("button", {
          name: "Unlink Anneke Brightwater from Tidewrack Capital",
        }),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        within(rowFor("Halcyon Spur Ventures")).queryByRole("link", {
          name: "Anneke Brightwater",
        }),
      ).toBeNull(),
    );
  });
});
