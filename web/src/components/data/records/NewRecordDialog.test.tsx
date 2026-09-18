import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RECRUITING_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { splitFormAttributes } from "./NewRecordDialog";
import { mockClient, resetMockClient, typeBySlug } from "./testClient";
import { renderDataRoute, rowNames } from "./testKit";

vi.mock("../../../api/dataspacesClient", async () =>
  (await import("./testClient")).mockClientModule(),
);

const CANDIDATES = `/data/${RECRUITING_SPACE_ID}/t/candidate`;

beforeEach(() => {
  resetMockClient();
  window.localStorage.clear();
});

async function openDialog() {
  const view = renderDataRoute(CANDIDATES);
  await screen.findByTestId("data-records-table");
  await view.user.click(screen.getByRole("button", { name: "Add Candidate" }));
  const dialog = await screen.findByTestId("data-new-record");
  return { ...view, dialog };
}

describe("splitFormAttributes", () => {
  it("puts required attributes first and leaves relationships out", async () => {
    const type = await typeBySlug(RECRUITING_SPACE_ID, "candidate");
    const { required, optional } = splitFormAttributes(type);
    expect(required.map((attribute) => attribute.slug)).toEqual(["name"]);
    expect(optional.map((attribute) => attribute.slug)).toEqual([
      "email",
      "stage",
      "skills",
      "linkedin",
      "phone",
    ]);
  });
});

describe("<NewRecordDialog>", () => {
  it("shows required fields first with real labels, optional ones behind a disclosure", async () => {
    const { user, dialog } = await openDialog();
    const name = within(dialog).getByLabelText(/^Name/);
    expect(name).toBeInTheDocument();
    const summary = within(dialog).getByText("Optional attributes");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    // The name field comes before the disclosure in document order.
    expect(
      name.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText(/^Role/)).toBeNull();
    await user.click(summary);
    expect(within(dialog).getByLabelText(/^Email/)).toBeInTheDocument();
  });

  it("shows a unique-email error on the Email field and keeps the dialog open", async () => {
    const type = await typeBySlug(RECRUITING_SPACE_ID, "candidate");
    const existing = await mockClient().queryRecords(RECRUITING_SPACE_ID, {
      typeId: type.id,
      limit: 1,
      offset: 0,
    });
    const takenEmail = String(existing.records[0].values.email);

    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(/^Name/), "Nadia Ferreira");
    await user.click(within(dialog).getByText("Optional attributes"));
    await user.type(within(dialog).getByLabelText(/^Email/), takenEmail);
    await user.click(
      within(dialog).getByRole("button", { name: "Add Candidate" }),
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/already used by record/);
    expect(alert.closest(".dr-form-row")).toContainElement(
      within(dialog).getByLabelText(/^Email/),
    );
    expect(screen.getByTestId("data-new-record")).toBeInTheDocument();
  });

  it("reopens the optional section when the rejected field is inside it", async () => {
    const type = await typeBySlug(RECRUITING_SPACE_ID, "candidate");
    const existing = await mockClient().queryRecords(RECRUITING_SPACE_ID, {
      typeId: type.id,
      limit: 1,
      offset: 0,
    });
    const takenEmail = String(existing.records[0].values.email);
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(/^Name/), "Nadia Ferreira");
    const summary = within(dialog).getByText("Optional attributes");
    await user.click(summary);
    await user.type(within(dialog).getByLabelText(/^Email/), takenEmail);
    await user.click(summary);
    expect(summary.closest("details")?.open).toBe(false);
    await user.click(
      within(dialog).getByRole("button", { name: "Add Candidate" }),
    );
    await within(dialog).findByRole("alert");
    expect(summary.closest("details")?.open).toBe(true);
  });

  it("a missing required name is a field error from the store", async () => {
    const { user, dialog } = await openDialog();
    await user.click(
      within(dialog).getByRole("button", { name: "Add Candidate" }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(alert.closest(".dr-form-row")).toContainElement(
      within(dialog).getByLabelText(/^Name/),
    );
  });

  it("on success it closes, toasts, adds the row, and peeks the new record", async () => {
    const { user, dialog, router } = await openDialog();
    await user.type(within(dialog).getByLabelText(/^Name/), "Nadia Ferreira");
    await user.click(
      within(dialog).getByRole("button", { name: "Add Candidate" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("data-new-record")).toBeNull(),
    );
    expect(
      await screen.findByText("Added Nadia Ferreira."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.search.peek).toMatch(/^rec_/),
    );
    await waitFor(() => expect(rowNames()).toContain("Nadia Ferreira"));
    const peek = await screen.findByTestId("data-peek");
    expect(
      await within(peek).findByRole("heading", { name: "Nadia Ferreira" }),
    ).toBeInTheDocument();
  });
});
