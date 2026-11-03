import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataClient } from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { CreateObjectTypeDialog } from "./CreateObjectTypeDialog";
import { createTestClient, renderData } from "./dataTestKit";

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../../../api/dataspacesClient", () => ({
  get dataClient() {
    return holder.client;
  },
}));

const SPACE = SEED_RAISE_SPACE_ID;
const TAKEN = ["investor", "firm", "meeting"];

function setup() {
  const client: DataClient = createTestClient();
  holder.client = client;
  const onClose = vi.fn();
  const view = renderData(
    <CreateObjectTypeDialog
      spaceId={SPACE}
      takenSlugs={TAKEN}
      open={true}
      onClose={onClose}
    />,
    `/data/${SPACE}`,
  );
  return { ...view, client, onClose };
}

beforeEach(() => {
  holder.client = null;
});

describe("<CreateObjectTypeDialog>", () => {
  it("derives the plural and the slug from the name until the plural is edited", async () => {
    const { user } = setup();
    const name = await screen.findByRole("textbox", { name: /^Name/ });
    const plural = screen.getByRole("textbox", { name: "Plural name" });

    await user.type(name, "Portfolio Company");
    expect(plural).toHaveValue("Portfolio Companies");
    expect(screen.getByText("portfolio_company")).toBeInTheDocument();

    await user.clear(plural);
    await user.type(plural, "Portcos");
    await user.type(name, " Two");
    expect(plural).toHaveValue("Portcos");
    expect(screen.getByText("portfolio_company_two")).toBeInTheDocument();
  });

  it("previews the suffix the store adds for a taken slug", async () => {
    const { user } = setup();
    await user.type(
      await screen.findByRole("textbox", { name: /^Name/ }),
      "Firm!",
    );
    expect(screen.getByText("firm_2")).toBeInTheDocument();
  });

  it("offers the icons as one keyboard-operable radio group", async () => {
    const { user } = setup();
    const radios = await screen.findAllByRole("radio");
    expect(radios.length).toBeGreaterThan(10);
    expect(screen.getByRole("radio", { name: "box" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "building" }));
    expect(screen.getByRole("radio", { name: "building" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "box" })).not.toBeChecked();
  });

  it("shows the store's duplicate-name error inline and stays open", async () => {
    const { user, onClose, router } = setup();
    await user.type(
      await screen.findByRole("textbox", { name: /^Name/ }),
      "investor",
    );
    await user.click(
      screen.getByRole("button", { name: "Create object type" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /An object type named "Investor" already exists/,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe(`/data/${SPACE}`);
  });

  it("creates the type and lands on its Attributes tab", async () => {
    const { user, client, onClose, router } = setup();
    await user.type(
      await screen.findByRole("textbox", { name: /^Name/ }),
      "Term Sheet",
    );
    await user.click(screen.getByRole("radio", { name: "doc" }));
    await user.click(
      screen.getByRole("button", { name: "Create object type" }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/data/${SPACE}/t/term_sheet/settings`,
      );
    });
    expect(router.state.location.search).toEqual({ tab: "attributes" });
    expect(onClose).toHaveBeenCalledTimes(1);
    const schema = await client.getSchema(SPACE);
    const created = schema.objectTypes.find(
      (type) => type.slug === "term_sheet",
    );
    expect(created).toMatchObject({
      name: "Term Sheet",
      namePlural: "Term Sheets",
      icon: "doc",
    });
  });

  it("cannot be submitted without a name", async () => {
    setup();
    expect(
      await screen.findByRole("button", { name: "Create object type" }),
    ).toBeDisabled();
  });
});
