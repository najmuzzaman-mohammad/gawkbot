import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { mockClient, resetMockClient, typeBySlug } from "./testClient";
import { renderDataRoute, rowNames } from "./testKit";

vi.mock("../../../api/dataspacesClient", async () =>
  (await import("./testClient")).mockClientModule(),
);

const INVESTORS = `/data/${SEED_RAISE_SPACE_ID}/t/investor`;

beforeEach(() => {
  resetMockClient();
  window.localStorage.clear();
});

async function tableReady() {
  return screen.findByTestId("data-records-table");
}

describe("<RecordsPage> table", () => {
  it("renders the fixture investors with one column per attribute", async () => {
    renderDataRoute(INVESTORS);
    const table = await tableReady();
    expect(
      screen.getByRole("heading", { level: 1, name: "Investors" }),
    ).toBeInTheDocument();
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.getAttribute("data-column"));
    expect(headers).toEqual([
      "_select",
      "name",
      "email",
      "stage",
      "check_size",
      "notes",
      "firm",
      "meetings",
      "_updated_at",
      "_actions",
    ]);
    expect(rowNames()).toHaveLength(22);
    expect(rowNames()).toContain("Mirela Okonjo-Hart");
    expect(screen.getByText("1 to 22 of 22")).toBeInTheDocument();
  });

  it("shows a not-found state for an unknown object type", async () => {
    renderDataRoute(`/data/${SEED_RAISE_SPACE_ID}/t/nope`);
    expect(
      await screen.findByText("This object type does not exist"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Seed raise" }),
    ).toBeInTheDocument();
  });

  it("sorts by Stage from the column menu and writes the URL", async () => {
    const { user, router } = renderDataRoute(INVESTORS);
    await tableReady();
    await user.click(
      screen.getByRole("button", { name: "Stage column options" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        sort: "stage",
        dir: "asc",
      }),
    );
    expect(
      await screen.findByText("Sorted by Stage, ascending"),
    ).toBeInTheDocument();
    const type = await typeBySlug(SEED_RAISE_SPACE_ID, "investor");
    const expected = await mockClient().queryRecords(SEED_RAISE_SPACE_ID, {
      typeId: type.id,
      sort: { attribute: "stage", direction: "asc" },
      limit: 30,
      offset: 0,
    });
    await waitFor(() =>
      expect(rowNames()).toEqual(
        expected.records.map((record) => String(record.values.name)),
      ),
    );
    await waitFor(() => {
      const stageHeader = screen
        .getAllByRole("columnheader")
        .find((header) => header.getAttribute("data-column") === "stage");
      expect(stageHeader).toHaveAttribute("aria-sort", "ascending");
    });
  });
});

describe("<RecordsPage> search, filter, pagination", () => {
  it("search narrows the rows, writes q, and resets the page", async () => {
    const { user, router } = renderDataRoute(`${INVESTORS}?size=10&page=2`);
    await tableReady();
    expect(screen.getByText("11 to 20 of 22")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Search investors" }),
      "okonjo",
    );
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ size: 10, q: "okonjo" }),
    );
    await waitFor(() => expect(rowNames()).toEqual(["Mirela Okonjo-Hart"]));
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ size: 10 }),
    );
  });

  it("the filter panel writes and removes the filter param", async () => {
    const { user, router } = renderDataRoute(`${INVESTORS}?page=1`);
    await tableReady();
    await user.click(screen.getByRole("button", { name: /^Filter/ }));
    await user.click(await screen.findByRole("button", { name: "Add filter" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter 1 attribute" }),
      "stage",
    );
    // Incomplete rows stay out of the URL.
    expect(router.state.location.search.filter).toBeUndefined();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter 1 value" }),
      "Pitched",
    );
    await waitFor(() =>
      expect(router.state.location.search.filter).toBe("stage.equals.Pitched"),
    );
    await waitFor(() => expect(rowNames().length).toBeLessThan(22));
    expect(screen.getByRole("button", { name: /^Filter/ })).toHaveTextContent(
      "1",
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter 1 operator" }),
      "is_empty",
    );
    expect(
      screen.queryByRole("combobox", { name: "Filter 1 value" }),
    ).toBeNull();
    await waitFor(() =>
      expect(router.state.location.search.filter).toBe("stage.is_empty"),
    );

    await user.click(screen.getByRole("button", { name: "Remove filter 1" }));
    await waitFor(() =>
      expect(router.state.location.search.filter).toBeUndefined(),
    );
  });

  it("offers Clear filters, not Add, when nothing matches", async () => {
    const { user, router } = renderDataRoute(`${INVESTORS}?q=zzzznothing`);
    expect(await screen.findByText("No investors match")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add Investor" }),
    ).not.toBeNull();
    // The header keeps its Add button; the empty state itself offers only Clear.
    const empty = screen.getByText("No investors match").closest(".data-empty");
    expect(
      within(empty as HTMLElement).queryByRole("button", { name: /Add/ }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await tableReady();
  });

  it("pages forward and back and changes the page size, all in the URL", async () => {
    const { user, router } = renderDataRoute(`${INVESTORS}?size=10`);
    await tableReady();
    expect(screen.getByText("1 to 10 of 22")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(router.state.location.search.page).toBe(2));
    expect(await screen.findByText("11 to 20 of 22")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await waitFor(() =>
      expect(router.state.location.search.page).toBeUndefined(),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Rows per page" }),
      "50",
    );
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ size: 50 }),
    );
    expect(await screen.findByText("1 to 22 of 22")).toBeInTheDocument();
  });

  it("moves to the last valid page when the page is past the end", async () => {
    const { router } = renderDataRoute(`${INVESTORS}?size=10&page=9`);
    await waitFor(() => expect(router.state.location.search.page).toBe(3));
    expect(await screen.findByText("21 to 22 of 22")).toBeInTheDocument();
  });
});
