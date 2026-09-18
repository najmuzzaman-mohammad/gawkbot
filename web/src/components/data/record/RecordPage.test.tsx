import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataRecord } from "../../../api/dataspaces";
import {
  RECRUITING_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { mockClient, resetMockClient, typeBySlug } from "../records/testClient";
import { renderDataRoute } from "../records/testKit";

vi.mock("../../../api/dataspacesClient", async () =>
  (await import("../records/testClient")).mockClientModule(),
);

beforeEach(() => {
  resetMockClient();
  window.localStorage.clear();
});

async function findRecord(
  spaceId: string,
  typeSlug: string,
  query: string,
): Promise<DataRecord> {
  const type = await typeBySlug(spaceId, typeSlug);
  const page = await mockClient().queryRecords(spaceId, {
    typeId: type.id,
    query,
    limit: 1,
    offset: 0,
  });
  return mockClient().getRecord(spaceId, page.records[0].id);
}

const recordPath = (spaceId: string, id: string) => `/data/${spaceId}/r/${id}`;

describe("<RecordPage>", () => {
  it("shows the header, crumbs, attributes, and details", async () => {
    const mirela = await findRecord(SEED_RAISE_SPACE_ID, "investor", "Mirela");
    renderDataRoute(recordPath(SEED_RAISE_SPACE_ID, mirela.id));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Mirela Okonjo-Hart",
      }),
    ).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Data breadcrumb" });
    expect(
      within(crumbs)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Data", "Seed raise", "Investors", "Mirela Okonjo-Hart"]);
    expect(screen.queryByRole("tablist")).toBeNull();

    const attributes = screen
      .getByRole("heading", { name: "Attributes" })
      .closest("section") as HTMLElement;
    expect(within(attributes).getByText("Email")).toBeInTheDocument();
    expect(
      within(attributes).getByRole("link", {
        name: String(mirela.values.email),
      }),
    ).toBeInTheDocument();
    // Relationships have their own section, never an attribute cell.
    expect(within(attributes).queryByText("Firm")).toBeNull();

    const details = screen.getByRole("complementary", { name: "Details" });
    expect(within(details).getByText(mirela.id)).toHaveClass("data-mono");
    expect(
      within(details).getByRole("link", { name: "app_5eed0a1b2c3d4e5f" }),
    ).toHaveAttribute("href", "/apps/app_5eed0a1b2c3d4e5f");
    // No fabricated activity.
    expect(screen.queryByText(/activity/i)).toBeNull();
  });

  it("says when no app uses the space", async () => {
    const candidate = await findRecord(
      RECRUITING_SPACE_ID,
      "candidate",
      "Freya",
    );
    renderDataRoute(recordPath(RECRUITING_SPACE_ID, candidate.id));
    expect(
      await screen.findByText("No apps use this data space yet."),
    ).toBeInTheDocument();
  });

  it("shows a not-found state for an unknown id", async () => {
    renderDataRoute(recordPath(SEED_RAISE_SPACE_ID, "rec_missing"));
    expect(
      await screen.findByText("This record does not exist"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Seed raise" }),
    ).toBeInTheDocument();
  });

  it("edits an attribute in place and returns focus to it", async () => {
    const tobias = await findRecord(SEED_RAISE_SPACE_ID, "investor", "Tobias");
    const { user } = renderDataRoute(
      recordPath(SEED_RAISE_SPACE_ID, tobias.id),
    );
    const trigger = await screen.findByRole("button", {
      name: /^Edit Check size:/,
    });
    await user.click(trigger);
    const input = screen.getByRole("textbox", { name: "Check size (USD)" });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "750000{Enter}");
    const updated = await screen.findByRole("button", {
      name: /^Edit Check size:.*750,000/,
    });
    await waitFor(() => expect(updated).toHaveFocus());
    await waitFor(async () => {
      const stored = await mockClient().getRecord(
        SEED_RAISE_SPACE_ID,
        tobias.id,
      );
      expect(stored.values.check_size).toBe(750000);
    });
  });

  it("Escape cancels an edit without writing", async () => {
    const tobias = await findRecord(SEED_RAISE_SPACE_ID, "investor", "Tobias");
    const { user } = renderDataRoute(
      recordPath(SEED_RAISE_SPACE_ID, tobias.id),
    );
    const trigger = await screen.findByRole("button", {
      name: /^Edit Check size:/,
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "Check size (USD)" });
    await user.clear(input);
    await user.type(input, "1{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    const stored = await mockClient().getRecord(SEED_RAISE_SPACE_ID, tobias.id);
    expect(stored.values.check_size).toBe(tobias.values.check_size);
  });

  it("renames the record from the header", async () => {
    const mirela = await findRecord(SEED_RAISE_SPACE_ID, "investor", "Mirela");
    const { user } = renderDataRoute(
      recordPath(SEED_RAISE_SPACE_ID, mirela.id),
    );
    await user.click(
      await screen.findByRole("button", { name: /^Edit Name:/ }),
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Mirela O.{Enter}");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Mirela O." }),
    ).toBeInTheDocument();
  });

  it("opens an empty attribute from the Empty strip and fills it", async () => {
    const type = await typeBySlug(RECRUITING_SPACE_ID, "candidate");
    const page = await mockClient().queryRecords(RECRUITING_SPACE_ID, {
      typeId: type.id,
      filters: [{ attribute: "phone", operator: "is_empty" }],
      limit: 1,
      offset: 0,
    });
    const [candidate] = page.records;
    const { user } = renderDataRoute(
      recordPath(RECRUITING_SPACE_ID, candidate.id),
    );
    const chip = await screen.findByRole("button", { name: "Add Phone" });
    await user.click(chip);
    const input = screen.getByRole("textbox", { name: "Phone" });
    expect(input).toHaveFocus();
    await user.type(input, "+1 415 555 0199{Enter}");
    expect(
      await screen.findByRole("link", { name: "+1 415 555 0199" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Phone" })).toBeNull();
  });

  it("a cancelled Empty chip comes back and takes focus", async () => {
    const type = await typeBySlug(RECRUITING_SPACE_ID, "candidate");
    const page = await mockClient().queryRecords(RECRUITING_SPACE_ID, {
      typeId: type.id,
      filters: [{ attribute: "phone", operator: "is_empty" }],
      limit: 1,
      offset: 0,
    });
    const { user } = renderDataRoute(
      recordPath(RECRUITING_SPACE_ID, page.records[0].id),
    );
    await user.click(await screen.findByRole("button", { name: "Add Phone" }));
    await user.keyboard("{Escape}");
    const chip = await screen.findByRole("button", { name: "Add Phone" });
    await waitFor(() => expect(chip).toHaveFocus());
  });

  it("shows the store's message when an in-place edit is rejected", async () => {
    const type = await typeBySlug(RECRUITING_SPACE_ID, "candidate");
    const page = await mockClient().queryRecords(RECRUITING_SPACE_ID, {
      typeId: type.id,
      limit: 2,
      offset: 0,
    });
    const [first, second] = page.records;
    const { user } = renderDataRoute(recordPath(RECRUITING_SPACE_ID, first.id));
    await user.click(await screen.findByRole("button", { name: "Edit Email" }));
    const input = screen.getByRole("textbox", { name: "Email" });
    await user.clear(input);
    await user.type(input, `${String(second.values.email)}{Enter}`);
    expect(
      await screen.findByText(/already used by record/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: String(first.values.email) }),
    ).toBeInTheDocument();
  });
});

describe("<RecordPage> relationships", () => {
  it("shows one section per relationship attribute with the right counts", async () => {
    const mirela = await findRecord(SEED_RAISE_SPACE_ID, "investor", "Mirela");
    renderDataRoute(recordPath(SEED_RAISE_SPACE_ID, mirela.id));
    const firm = await screen.findByTestId("data-relationship-firm");
    const meetings = screen.getByTestId("data-relationship-meetings");
    expect(within(firm).getByRole("heading", { level: 3 })).toHaveTextContent(
      "Firm1 linked",
    );
    expect(
      within(firm).getByRole("link", { name: "Tidewrack Capital" }),
    ).toBeInTheDocument();
    expect(
      within(firm).getByRole("link", { name: "Firms" }),
    ).toBeInTheDocument();
    expect(
      within(meetings).getByRole("heading", { level: 3 }),
    ).toHaveTextContent(`Meetings${mirela.links.meetings.length} linked`);
    expect(meetings.querySelectorAll(".dr-chip-link")).toHaveLength(
      mirela.links.meetings.length,
    );
  });

  it("caps a long list at 12 with a Show all toggle", async () => {
    const role = await findRecord(RECRUITING_SPACE_ID, "role", "Backend");
    expect(role.links.candidates).toHaveLength(8);
    // Move five more candidates onto this role so the list crosses the cap.
    const type = await typeBySlug(RECRUITING_SPACE_ID, "candidate");
    const everyone = await mockClient().queryRecords(RECRUITING_SPACE_ID, {
      typeId: type.id,
      limit: 100,
      offset: 0,
    });
    const linkedIds = new Set(role.links.candidates.map((ref) => ref.id));
    const extra = everyone.records
      .filter((record) => !linkedIds.has(record.id))
      .slice(0, 5);
    for (const record of extra) {
      await mockClient().linkRecords(
        RECRUITING_SPACE_ID,
        role.id,
        "candidates",
        record.id,
        true,
      );
    }

    const { user } = renderDataRoute(recordPath(RECRUITING_SPACE_ID, role.id));
    const section = await screen.findByTestId("data-relationship-candidates");
    expect(
      within(section).getByRole("heading", { level: 3 }),
    ).toHaveTextContent("Candidates13 linked");
    expect(section.querySelectorAll(".dr-chip-link")).toHaveLength(12);
    const toggle = within(section).getByRole("button", { name: "Show all 13" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(section.querySelectorAll(".dr-chip-link")).toHaveLength(13);
    expect(
      within(section).getByRole("button", { name: "Show first 12" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("links a new target from the section and updates the count", async () => {
    const wilhelmina = await findRecord(
      SEED_RAISE_SPACE_ID,
      "investor",
      "Wilhelmina",
    );
    const { user } = renderDataRoute(
      recordPath(SEED_RAISE_SPACE_ID, wilhelmina.id),
    );
    const section = await screen.findByTestId("data-relationship-firm");
    expect(
      within(section).getByText("No firms linked yet."),
    ).toBeInTheDocument();
    await user.click(
      within(section).getByRole("button", { name: "Link Firm for Firm" }),
    );
    const picker = await screen.findByTestId("data-record-picker");
    await user.click(
      await within(picker).findByRole("option", {
        name: "Emberquill Ventures",
      }),
    );
    expect(
      await within(section).findByRole("link", { name: "Emberquill Ventures" }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("heading", { level: 3 }),
    ).toHaveTextContent("Firm1 linked");
    // To-one and now set: the control says what it will do next.
    expect(
      await within(section).findByRole("button", {
        name: "Change Firm for Firm",
      }),
    ).toBeInTheDocument();
  });

  it("unlinks from the section", async () => {
    const mirela = await findRecord(SEED_RAISE_SPACE_ID, "investor", "Mirela");
    const { user } = renderDataRoute(
      recordPath(SEED_RAISE_SPACE_ID, mirela.id),
    );
    const section = await screen.findByTestId("data-relationship-firm");
    await user.click(
      within(section).getByRole("button", {
        name: "Unlink Tidewrack Capital from Mirela Okonjo-Hart",
      }),
    );
    expect(
      await within(section).findByText("No firms linked yet."),
    ).toBeInTheDocument();
  });
});
