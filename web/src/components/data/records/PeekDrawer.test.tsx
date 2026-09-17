import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { mockClient, resetMockClient, typeBySlug } from "./testClient";
import { renderDataRoute } from "./testKit";

vi.mock("../../../api/dataspacesClient", async () =>
  (await import("./testClient")).mockClientModule(),
);

const INVESTORS = `/data/${SEED_RAISE_SPACE_ID}/t/investor`;

beforeEach(() => {
  resetMockClient();
  window.localStorage.clear();
});

async function mirelaId(): Promise<string> {
  const type = await typeBySlug(SEED_RAISE_SPACE_ID, "investor");
  const page = await mockClient().queryRecords(SEED_RAISE_SPACE_ID, {
    typeId: type.id,
    query: "Mirela",
    limit: 1,
    offset: 0,
  });
  return page.records[0].id;
}

describe("<PeekDrawer>", () => {
  it("opens from the peek param with the header, attributes, relationships, and one link", async () => {
    const id = await mirelaId();
    renderDataRoute(`${INVESTORS}?peek=${id}`);
    const peek = await screen.findByTestId("data-peek");
    expect(
      await within(peek).findByRole("heading", { name: "Mirela Okonjo-Hart" }),
    ).toBeInTheDocument();
    expect(within(peek).getByText("Investor")).toBeInTheDocument();
    expect(within(peek).getByText("Email")).toBeInTheDocument();
    expect(
      within(peek).getByRole("link", { name: "Tidewrack Capital" }),
    ).toBeInTheDocument();
    const open = within(peek).getByRole("link", { name: "Open full record" });
    expect(open.getAttribute("href")).toContain(
      `/data/${SEED_RAISE_SPACE_ID}/r/${id}`,
    );
    // Read-only: nothing in the drawer is an editable cell.
    expect(peek.querySelector('[data-editable="true"]')).toBeNull();
  });

  it("closing clears the peek param and keeps the rest of the view", async () => {
    const id = await mirelaId();
    const { user, router } = renderDataRoute(
      `${INVESTORS}?sort=stage&peek=${id}`,
    );
    const peek = await screen.findByTestId("data-peek");
    await user.click(within(peek).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ sort: "stage" }),
    );
    await waitFor(() => expect(screen.queryByTestId("data-peek")).toBeNull());
  });

  it("Escape closes it", async () => {
    const id = await mirelaId();
    const { user, router } = renderDataRoute(`${INVESTORS}?peek=${id}`);
    await screen.findByTestId("data-peek");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(router.state.location.search.peek).toBeUndefined(),
    );
  });

  it("the Preview chip in the name cell sets peek", async () => {
    const id = await mirelaId();
    const { user, router } = renderDataRoute(INVESTORS);
    await screen.findByTestId("data-records-table");
    // Two controls preview a row: the chip in the name cell and the row
    // action. The chip comes first in the row.
    const [chip] = screen.getAllByRole("button", {
      name: "Preview Mirela Okonjo-Hart",
    });
    expect(chip).toHaveClass("dr-preview-chip");
    await user.click(chip);
    await waitFor(() => expect(router.state.location.search.peek).toBe(id));
    expect(await screen.findByTestId("data-peek")).toBeInTheDocument();
  });

  it("says so when the peeked record does not exist", async () => {
    renderDataRoute(`${INVESTORS}?peek=rec_missing`);
    expect(await screen.findByText("Record not found")).toBeInTheDocument();
  });
});
