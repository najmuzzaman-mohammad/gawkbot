import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataClient } from "../../../api/dataspaces";
import {
  RECRUITING_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { PRIVATE_ACCESS } from "../../../api/dataspacesAccess";
import { DataSpacePage } from "./DataSpacePage";
import { createTestClient, renderData } from "./dataTestKit";
import { ShareSpaceDialogView } from "./ShareSpaceDialog";

const holder = vi.hoisted(() => ({
  client: null as unknown,
  roster: [] as string[],
}));

vi.mock("../../../api/dataspacesClient", () => ({
  get dataClient() {
    return holder.client;
  },
}));

vi.mock("../../../hooks/useMembers", () => ({
  useOfficeMembers: () => ({
    data: holder.roster.map((slug) => ({ slug, name: slug, role: "" })),
  }),
}));

const SPACE = SEED_RAISE_SPACE_ID;
const ROSTER = ["cos", "ops", "recruiter", "designer", "human"];

async function openFromPage(spaceId = SPACE) {
  const client: DataClient = createTestClient();
  holder.client = client;
  const view = renderData(
    <DataSpacePage spaceId={spaceId} />,
    `/data/${spaceId}`,
  );
  await view.user.click(await screen.findByRole("button", { name: "Share" }));
  const dialog = await screen.findByTestId("data-share-space");
  return { ...view, client, dialog };
}

function levelRadio(dialog: HTMLElement, bot: string, label: string) {
  const group = within(dialog).getByRole("group", {
    name: `Access for @${bot}`,
  });
  return within(group).getByRole("radio", { name: label });
}

async function storedAccess(client: DataClient, spaceId: string) {
  const spaces = await client.listSpaces();
  return spaces.find((space) => space.id === spaceId)?.access;
}

beforeEach(() => {
  holder.client = null;
  holder.roster = [...ROSTER];
});

describe("<ShareSpaceDialog> from the space page", () => {
  it("explains the three scopes with the real owner, and Save waits for a change", async () => {
    const { dialog } = await openFromPage();
    expect(
      within(dialog).getByRole("heading", { name: "Share Seed raise" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("radio", { name: "Private" }),
    ).toBeChecked();
    expect(
      within(dialog).getByText("Only @cos and you can use this data space."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("@cos, you, and the bots you pick."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    // The bot list only appears for Shared.
    expect(within(dialog).queryByRole("group", { name: "Bots" })).toBeNull();
  });

  it("shares Seed raise with @ops at read and the page badge follows", async () => {
    const { user, client, dialog } = await openFromPage();
    expect(
      screen.getByText("Private", { selector: ".data-access-badge" }),
    ).toHaveClass("data-access-badge--private");

    await user.click(within(dialog).getByRole("radio", { name: "Shared" }));
    // The owner and the operator are never offered.
    expect(
      within(dialog).queryByRole("group", { name: "Access for @cos" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("group", { name: "Access for @human" }),
    ).toBeNull();
    expect(levelRadio(dialog, "ops", "No access")).toBeChecked();

    await user.click(levelRadio(dialog, "ops", "Can read"));
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => {
      expect(screen.queryByTestId("data-share-space")).toBeNull();
    });
    expect(await screen.findByText("Shared with @ops")).toHaveClass(
      "data-access-badge--shared",
    );
    expect(await storedAccess(client, SPACE)).toEqual({
      scope: "shared",
      grants: [{ bot: "ops", level: "read" }],
    });
  });

  it("says so when Shared has nobody, and stores it as private", async () => {
    const { user, client, dialog } = await openFromPage(RECRUITING_SPACE_ID);
    expect(within(dialog).getByRole("radio", { name: "Shared" })).toBeChecked();
    expect(levelRadio(dialog, "cos", "Can write")).toBeChecked();
    expect(levelRadio(dialog, "ops", "Can read")).toBeChecked();

    await user.click(levelRadio(dialog, "cos", "No access"));
    await user.click(levelRadio(dialog, "ops", "No access"));
    expect(
      within(dialog).getByText("Pick at least one bot, or choose Private."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByTestId("data-share-space")).toBeNull();
    });
    expect(await storedAccess(client, RECRUITING_SPACE_ID)).toEqual(
      PRIVATE_ACCESS,
    );
  });

  it("confirms inline before going global, then saves", async () => {
    const { user, client, dialog } = await openFromPage();
    const line = "Every bot will be able to change this data.";
    expect(within(dialog).queryByText(line)).toBeNull();

    await user.click(within(dialog).getByRole("radio", { name: "Global" }));
    expect(within(dialog).getByText(line)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Global")).toHaveClass(
      "data-access-badge--global",
    );
    expect(await storedAccess(client, SPACE)).toEqual({
      scope: "global",
      grants: [],
    });
  });

  it("goes back to not dirty when the change is undone", async () => {
    const { user, dialog } = await openFromPage();
    const save = within(dialog).getByRole("button", { name: "Save" });
    await user.click(within(dialog).getByRole("radio", { name: "Global" }));
    expect(save).toBeEnabled();
    await user.click(within(dialog).getByRole("radio", { name: "Private" }));
    expect(save).toBeDisabled();
  });
});

describe("<ShareSpaceDialogView>", () => {
  async function renderView(
    roster: readonly string[],
    spaceId = RECRUITING_SPACE_ID,
  ) {
    const client: DataClient = createTestClient();
    holder.client = client;
    const found = (await client.listSpaces()).find(
      (space) => space.id === spaceId,
    );
    if (!found) throw new Error("fixture space missing");
    const onClose = vi.fn();
    const view = renderData(
      <ShareSpaceDialogView space={found} roster={roster} onClose={onClose} />,
    );
    const dialog = await screen.findByTestId("data-share-space");
    return { ...view, client, dialog, onClose, space: found };
  }

  it("still renders a bot that holds a grant but left the office", async () => {
    // Recruiting grants @cos and @ops; only @designer is in this roster.
    const { dialog } = await renderView(["recruiter", "designer"]);
    const list = within(dialog).getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("@designer"),
      expect.stringContaining("@cos"),
      expect.stringContaining("@ops"),
    ]);
    expect(within(rows[0]).queryByText("not in the office")).toBeNull();
    expect(within(rows[1]).getByText("not in the office")).toBeInTheDocument();
    expect(levelRadio(dialog, "cos", "Can write")).toBeChecked();
  });

  it("shows the filter only for a large roster", async () => {
    const small = await renderView(ROSTER);
    expect(within(small.dialog).queryByRole("searchbox")).toBeNull();
    small.unmount();

    const many = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "ops"];
    const { user, dialog } = await renderView(many);
    const filter = within(dialog).getByRole("searchbox", {
      name: "Filter bots",
    });
    await user.type(filter, "b7");
    expect(
      within(within(dialog).getByRole("list")).getAllByRole("listitem"),
    ).toHaveLength(1);
    await user.clear(filter);
    await user.type(filter, "nobody");
    expect(
      within(dialog).getByText('No bot matches "nobody".'),
    ).toBeInTheDocument();
  });

  it("renders a server error inline and stays open", async () => {
    const { user, client, dialog, onClose } = await renderView(ROSTER);
    vi.spyOn(client, "updateSpaceAccess").mockRejectedValueOnce(
      new Error("The store refused the change."),
    );
    await user.click(within(dialog).getByRole("radio", { name: "Private" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The store refused the change.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
