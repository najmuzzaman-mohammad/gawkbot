import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataClient } from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { createTestClient, renderData, typeByName } from "../index/dataTestKit";
import { PRIMARY_DELETE_REASON } from "./AttributeRowMenu";
import { TypeSettingsPage, type TypeSettingsTab } from "./TypeSettingsPage";

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../../../api/dataspacesClient", () => ({
  get dataClient() {
    return holder.client;
  },
}));

const SPACE = SEED_RAISE_SPACE_ID;

function setup(tab: TypeSettingsTab, typeSlug = "investor") {
  const client: DataClient = createTestClient();
  holder.client = client;
  const view = renderData(
    <TypeSettingsPage spaceId={SPACE} typeSlug={typeSlug} tab={tab} />,
    `/data/${SPACE}/t/${typeSlug}/settings`,
  );
  return { ...view, client };
}

async function openRowMenu(
  user: ReturnType<typeof setup>["user"],
  attributeName: string,
) {
  await user.click(
    await screen.findByRole("button", { name: `Actions for ${attributeName}` }),
  );
  return screen.findByRole("menu");
}

beforeEach(() => {
  holder.client = null;
});

describe("<TypeSettingsPage> chrome", () => {
  it("renders the trail and tabs as links, marking the active tab", async () => {
    setup("attributes");
    await screen.findByRole("heading", { level: 1, name: "Investor settings" });
    const crumbs = screen.getByRole("navigation", {
      name: "Data breadcrumb",
    });
    expect(within(crumbs).getByRole("link", { name: "Data" })).toHaveAttribute(
      "href",
      "/data",
    );
    expect(
      within(crumbs).getByRole("link", { name: "Seed raise" }),
    ).toHaveAttribute("href", `/data/${SPACE}`);
    expect(
      within(crumbs).getByRole("link", { name: "Investors" }),
    ).toHaveAttribute("href", `/data/${SPACE}/t/investor`);
    expect(within(crumbs).getByText("Settings")).toHaveAttribute(
      "aria-current",
      "page",
    );

    const tabs = screen.getByRole("navigation", {
      name: "Object type settings",
    });
    const general = within(tabs).getByRole("link", { name: "General" });
    const attributes = within(tabs).getByRole("link", { name: "Attributes" });
    expect(general).toHaveAttribute(
      "href",
      `/data/${SPACE}/t/investor/settings?tab=general`,
    );
    expect(attributes).toHaveAttribute(
      "href",
      `/data/${SPACE}/t/investor/settings?tab=attributes`,
    );
    expect(attributes).toHaveAttribute("aria-current", "page");
    expect(general).not.toHaveAttribute("aria-current");
  });

  it("says so when the slug matches no object type", async () => {
    setup("general", "nope");
    expect(
      await screen.findByRole("heading", {
        name: "This object type does not exist",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Seed raise" }),
    ).toHaveAttribute("href", `/data/${SPACE}`);
  });
});

describe("<AttributesTab>", () => {
  it("lists every attribute with type, properties, slug, and author", async () => {
    setup("attributes");
    const name = await screen.findByTestId("attribute-row-name");
    expect(within(name).getByText("Primary")).toBeInTheDocument();
    expect(within(name).getByText("Required")).toBeInTheDocument();

    const email = screen.getByTestId("attribute-row-email");
    // Once as the attribute name, once as the type label.
    expect(within(email).getAllByText("Email")).toHaveLength(2);
    expect(within(email).getByText("Unique")).toBeInTheDocument();
    expect(within(email).getByText("email")).toHaveClass("data-mono");

    const stage = screen.getByTestId("attribute-row-stage");
    for (const option of [
      "Intro",
      "Pitched",
      "Diligence",
      "Committed",
      "Passed",
    ]) {
      expect(within(stage).getByText(option)).toBeInTheDocument();
    }

    const firm = screen.getByTestId("attribute-row-firm");
    expect(within(firm).getByText("Relation")).toBeInTheDocument();
    expect(
      within(firm).getByText("-> Firms (One Link per Source)"),
    ).toBeInTheDocument();

    expect(
      within(screen.getByTestId("attribute-row-check_size")).getByText("USD"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("attribute-row-notes")).getByText(
        "Created by you",
      ),
    ).toBeInTheDocument();
  });

  it("filters by name, slug, or type and explains an empty result", async () => {
    const { user } = setup("attributes");
    const search = await screen.findByRole("searchbox", {
      name: "Search attributes",
    });
    await user.type(search, "check_");
    expect(screen.getByTestId("attribute-row-check_size")).toBeInTheDocument();
    expect(screen.queryByTestId("attribute-row-email")).toBeNull();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText(/No attribute matches "zzz"/)).toBeInTheDocument();
  });

  it("disables Delete for the primary attribute and says why", async () => {
    const { user } = setup("attributes");
    const menu = await openRowMenu(user, "Name");
    const item = within(menu).getByRole("menuitem", { name: /Delete/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAttribute("title", PRIMARY_DELETE_REASON);
    expect(within(item).getByText(PRIMARY_DELETE_REASON)).toBeInTheDocument();

    await user.click(item);
    expect(screen.queryByTestId("data-delete-preview")).toBeNull();
  });

  it("deletes another attribute through the impact preview", async () => {
    const { user, client } = setup("attributes");
    const menu = await openRowMenu(user, "Notes");
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByTestId("data-delete-preview");
    expect(
      within(dialog).getByRole("heading", {
        name: "Delete the Notes attribute?",
      }),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText("1 attribute")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByTestId("attribute-row-notes")).toBeNull();
    });
    const investor = await typeByName(client, SPACE, "Investor");
    expect(investor.attributes.some((item) => item.slug === "notes")).toBe(
      false,
    );
  });

  it("copies the attribute id from the row menu", async () => {
    const { user, client } = setup("attributes");
    const investor = await typeByName(client, SPACE, "Investor");
    const email = investor.attributes.find((item) => item.slug === "email");
    const menu = await openRowMenu(user, "Email");
    await user.click(within(menu).getByRole("menuitem", { name: "Copy id" }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(email?.id);
    });
  });
});

describe("<EditAttributeDialog>", () => {
  it("renames an option by id and adds a new one, keeping the slug", async () => {
    const { user, client } = setup("attributes");
    const before = await typeByName(client, SPACE, "Investor");
    const stageBefore = before.attributes.find((item) => item.slug === "stage");
    const menu = await openRowMenu(user, "Stage");
    await user.click(within(menu).getByRole("menuitem", { name: "Edit" }));

    const dialog = await screen.findByTestId("data-edit-attribute");
    expect(
      within(dialog).getByText(
        /Renaming keeps existing records pointing at the same option\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Cannot change after creation."),
    ).toBeInTheDocument();
    const save = within(dialog).getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();

    const name = within(dialog).getByRole("textbox", { name: /^Name/ });
    await user.clear(name);
    await user.type(name, "Pipeline stage");
    const first = within(dialog).getByRole("textbox", { name: "Option 1" });
    await user.clear(first);
    await user.type(first, "Introduced");
    await user.type(
      within(dialog).getByRole("textbox", { name: "New option name" }),
      "Wired",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add option" }),
    );
    await user.click(save);

    await waitFor(() => {
      expect(screen.queryByTestId("data-edit-attribute")).toBeNull();
    });
    const after = await typeByName(client, SPACE, "Investor");
    const stage = after.attributes.find((item) => item.slug === "stage");
    expect(stage?.name).toBe("Pipeline stage");
    expect(stage?.options[0]).toEqual({
      ...stageBefore?.options[0],
      name: "Introduced",
    });
    expect(stage?.options.map((option) => option.name)).toContain("Wired");
  });

  it("locks Required on the primary attribute", async () => {
    const { user } = setup("attributes");
    const menu = await openRowMenu(user, "Name");
    await user.click(within(menu).getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByTestId("data-edit-attribute");
    expect(
      within(dialog).getByRole("checkbox", { name: "Required" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText("The primary attribute is always required."),
    ).toBeInTheDocument();
  });
});

describe("<GeneralTab>", () => {
  it("saves only once something changed, and keeps the slug", async () => {
    const { user, client } = setup("general");
    const save = await screen.findByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();

    const name = screen.getByRole("textbox", { name: /^Name/ });
    await user.clear(name);
    await user.type(name, "Backer");
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(save).toBeDisabled());
    const schema = await client.getSchema(SPACE);
    expect(
      schema.objectTypes.find((type) => type.slug === "investor")?.name,
    ).toBe("Backer");
  });

  it("shows a rename clash inline", async () => {
    const { user } = setup("general");
    const name = await screen.findByRole("textbox", { name: /^Name/ });
    await user.clear(name);
    await user.type(name, "Firm");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'An object type named "Firm" already exists.',
    );
  });

  it("shows the slug and id in mono with copy buttons", async () => {
    const { user, client } = setup("general");
    const investor = await typeByName(client, SPACE, "Investor");
    expect(await screen.findByText(investor.id)).toHaveClass("data-mono");
    expect(screen.getByText("investor")).toHaveClass("data-mono");
    await user.click(screen.getByRole("button", { name: "Copy id" }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(investor.id);
    });
  });

  it("previews the impact counts, deletes the type, and returns to the space", async () => {
    const { user, client, router } = setup("general");
    const investor = await typeByName(client, SPACE, "Investor");
    const expected = await client.previewDelete(SPACE, "object_type", [
      investor.id,
    ]);
    await user.click(
      await screen.findByRole("button", { name: "Delete object type" }),
    );

    const dialog = await screen.findByTestId("data-delete-preview");
    expect(
      within(dialog).getByRole("heading", {
        name: "Delete the Investor object type?",
      }),
    ).toBeInTheDocument();
    expect(
      await within(dialog).findByText("1 object type"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `${expected.impact.records.toLocaleString()} records`,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `${expected.impact.links.toLocaleString()} links between records`,
      ),
    ).toBeInTheDocument();
    expect(expected.impact.records).toBeGreaterThan(0);
    expect(expected.impact.links).toBeGreaterThan(0);

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/data/${SPACE}`);
    });
    // The page held the type on screen rather than flashing not-found.
    expect(
      screen.queryByRole("heading", {
        name: "This object type does not exist",
      }),
    ).toBeNull();
    const schema = await client.getSchema(SPACE);
    expect(schema.objectTypes.some((type) => type.slug === "investor")).toBe(
      false,
    );
  });

  // The store resolves which records a type holds, so the operator never has
  // to collect ids a page at a time, and the type itself survives.
  it("empties a type through the impact preview and keeps its schema", async () => {
    const { user, client } = setup("general");
    const investor = await typeByName(client, SPACE, "Investor");
    const expected = await client.previewDelete(SPACE, "records_of_type", [
      investor.id,
    ]);
    expect(expected.impact.records).toBeGreaterThan(0);

    await user.click(
      await screen.findByRole("button", { name: "Delete all records" }),
    );

    const dialog = await screen.findByTestId("data-delete-preview");
    expect(
      within(dialog).getByRole("heading", {
        name: "Delete every Investor record?",
      }),
    ).toBeInTheDocument();
    expect(
      await within(dialog).findByText(
        `${expected.impact.records.toLocaleString()} records`,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/object type/)).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(async () => {
      const after = await typeByName(client, SPACE, "Investor");
      expect(after.recordCount).toBe(0);
    });
    const after = await typeByName(client, SPACE, "Investor");
    expect(after.attributes.length).toBe(investor.attributes.length);
    // The page stays on the type it just emptied.
    expect(
      screen.getByRole("button", { name: "Delete object type" }),
    ).toBeInTheDocument();
  });
});
