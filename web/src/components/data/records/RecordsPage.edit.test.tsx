import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECRUITING_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { columnPrefsKey } from "./columnPrefs";
import { mockClient, resetMockClient, typeBySlug } from "./testClient";
import { renderDataRoute, rowNames } from "./testKit";

vi.mock("../../../api/dataspacesClient", async () =>
  (await import("./testClient")).mockClientModule(),
);

const INVESTORS = `/data/${SEED_RAISE_SPACE_ID}/t/investor`;
const CANDIDATES = `/data/${RECRUITING_SPACE_ID}/t/candidate`;

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

function cellIn(row: HTMLElement, type: string): HTMLElement {
  const cell = row.querySelector<HTMLElement>(`.dv-cell[data-type="${type}"]`);
  if (!cell) throw new Error(`no ${type} cell`);
  return cell;
}

describe("<RecordsPage> inline edit", () => {
  it("commits a text edit and keeps it after the store answers", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    const cell = cellIn(rowFor("Mirela Okonjo-Hart"), "text");
    cell.focus();
    await user.keyboard("{Enter}");
    const input = within(rowFor("Mirela Okonjo-Hart")).getByRole("textbox", {
      name: "Notes",
    });
    await user.clear(input);
    await user.type(input, "Warm intro from Priya{Enter}");
    await waitFor(() =>
      expect(
        within(rowFor("Mirela Okonjo-Hart")).getByText("Warm intro from Priya"),
      ).toBeInTheDocument(),
    );
    const type = await typeBySlug(SEED_RAISE_SPACE_ID, "investor");
    await waitFor(async () => {
      const page = await mockClient().queryRecords(SEED_RAISE_SPACE_ID, {
        typeId: type.id,
        query: "Mirela",
        limit: 5,
        offset: 0,
      });
      expect(page.records[0].values.notes).toBe("Warm intro from Priya");
    });
  });

  it("restores the old value and shows the store's message when a write is rejected", async () => {
    const { user } = renderDataRoute(CANDIDATES);
    await screen.findByTestId("data-records-table");
    const names = rowNames();
    const [first, second] = names;
    const takenEmail =
      cellIn(rowFor(second), "email").textContent?.trim() ?? "";
    const originalEmail =
      cellIn(rowFor(first), "email").textContent?.trim() ?? "";
    expect(takenEmail).not.toBe("");

    const cell = cellIn(rowFor(first), "email");
    cell.focus();
    await user.keyboard("{F2}");
    const input = within(rowFor(first)).getByRole("textbox", { name: "Email" });
    await user.clear(input);
    await user.type(input, `${takenEmail}{Enter}`);

    const toast = await screen.findByText(/already/i);
    expect(toast).toBeInTheDocument();
    await waitFor(() =>
      expect(cellIn(rowFor(first), "email")).toHaveTextContent(originalEmail),
    );
  });

  it("renames from the name cell with F2 and keeps the link", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    const link = within(rowFor("Tobias Vandersloot")).getByRole("link", {
      name: "Tobias Vandersloot",
    });
    link.focus();
    await user.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Tobias V.{Enter}");
    const renamed = await screen.findByRole("link", { name: "Tobias V." });
    expect(renamed.getAttribute("href")).toContain(
      `/data/${SEED_RAISE_SPACE_ID}/r/`,
    );
  });
});

describe("<RecordsPage> columns", () => {
  it("hides a column, persists it, and brings it back from the + menu", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    await user.click(
      screen.getByRole("button", { name: "Notes column options" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Hide" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Notes column options" }),
      ).toBeNull(),
    );
    const type = await typeBySlug(SEED_RAISE_SPACE_ID, "investor");
    const stored = window.localStorage.getItem(
      columnPrefsKey(SEED_RAISE_SPACE_ID, type.id),
    );
    expect(JSON.parse(stored ?? "{}")).toMatchObject({ hidden: ["notes"] });

    await user.click(screen.getByRole("button", { name: "Add column" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Show Notes" }),
    );
    expect(
      await screen.findByRole("button", { name: "Notes column options" }),
    ).toBeInTheDocument();
  });

  it("starts from stored preferences and drops slugs that no longer exist", async () => {
    const type = await typeBySlug(SEED_RAISE_SPACE_ID, "investor");
    window.localStorage.setItem(
      columnPrefsKey(SEED_RAISE_SPACE_ID, type.id),
      JSON.stringify({
        order: ["stage", "ghost", "email"],
        hidden: ["check_size", "ghost"],
      }),
    );
    renderDataRoute(INVESTORS);
    const table = await screen.findByTestId("data-records-table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.getAttribute("data-column"));
    expect(headers).toEqual([
      "_select",
      "name",
      "stage",
      "email",
      "notes",
      "firm",
      "meetings",
      "_updated_at",
      "_actions",
    ]);
  });

  it("moves a column right from its menu", async () => {
    const { user } = renderDataRoute(INVESTORS);
    const table = await screen.findByTestId("data-records-table");
    await user.click(
      screen.getByRole("button", { name: "Email column options" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Move right" }),
    );
    await waitFor(() => {
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((header) => header.getAttribute("data-column"));
      expect(headers.slice(2, 4)).toEqual(["stage", "email"]);
    });
  });
});

describe("<RecordsPage> selection and delete", () => {
  it("shows the impact, deletes the selected rows, and clears the selection", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    expect(
      screen.queryByRole("toolbar", { name: "Selected records" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("checkbox", { name: "Select Mirela Okonjo-Hart" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Select Tobias Vandersloot" }),
    );
    const bar = screen.getByRole("toolbar", { name: "Selected records" });
    expect(within(bar).getByText("2 selected")).toBeInTheDocument();

    await user.click(within(bar).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByTestId("data-delete-preview");
    expect(await within(dialog).findByText("2 records")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(rowNames()).toHaveLength(20));
    expect(rowNames()).not.toContain("Mirela Okonjo-Hart");
    expect(
      screen.queryByRole("toolbar", { name: "Selected records" }),
    ).toBeNull();
  });

  it("Clear drops the selection without deleting", async () => {
    const { user } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    await user.click(
      screen.getByRole("checkbox", { name: "Select every row on this page" }),
    );
    const bar = screen.getByRole("toolbar", { name: "Selected records" });
    expect(within(bar).getByText("22 selected")).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Clear" }));
    expect(
      screen.queryByRole("toolbar", { name: "Selected records" }),
    ).toBeNull();
    expect(rowNames()).toHaveLength(22);
  });
});
