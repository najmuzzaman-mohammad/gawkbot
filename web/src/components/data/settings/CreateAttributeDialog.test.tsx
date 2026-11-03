import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ATTRIBUTE_TYPES, type DataClient } from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { createTestClient, renderData, typeByName } from "../index/dataTestKit";
import { attributeTypeLabel } from "../values/valueFormat";
import { CreateAttributeDialog } from "./CreateAttributeDialog";

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../../../api/dataspacesClient", () => ({
  get dataClient() {
    return holder.client;
  },
}));

const SPACE = SEED_RAISE_SPACE_ID;

/** Opens the dialog on Firm, which has no relationship to Meeting yet. */
async function setup(typeName = "Firm") {
  const client: DataClient = createTestClient();
  holder.client = client;
  const schema = await client.getSchema(SPACE);
  const objectType = await typeByName(client, SPACE, typeName);
  const onClose = vi.fn();
  const view = renderData(
    <CreateAttributeDialog
      spaceId={SPACE}
      objectType={objectType}
      objectTypes={schema.objectTypes}
      open={true}
      onClose={onClose}
    />,
  );
  await screen.findByRole("list", { name: "Attribute types" });
  return { ...view, client, objectType, onClose };
}

async function pick(
  user: Awaited<ReturnType<typeof setup>>["user"],
  label: string,
) {
  await user.click(
    screen.getByRole("button", { name: new RegExp(`^${label}`) }),
  );
}

beforeEach(() => {
  holder.client = null;
});

describe("<CreateAttributeDialog> type picker", () => {
  it("offers all twelve types, each with a hint, before anything else", async () => {
    await setup();
    const list = screen.getByRole("list", { name: "Attribute types" });
    const options = within(list).getAllByRole("button");
    expect(options).toHaveLength(ATTRIBUTE_TYPES.length);
    for (const type of ATTRIBUTE_TYPES) {
      expect(
        within(list).getByText(attributeTypeLabel(type)),
      ).toBeInTheDocument();
    }
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("lets the operator go back and change the type", async () => {
    const { user } = await setup();
    await pick(user, "Text");
    await user.click(screen.getByRole("button", { name: "Change type" }));
    expect(
      screen.getByRole("list", { name: "Attribute types" }),
    ).toBeInTheDocument();
  });
});

describe("<CreateAttributeDialog> conditional controls", () => {
  it.each([
    ["Text", true, false],
    ["Number", true, false],
    ["Phone", true, false],
    ["Email", true, true],
    ["URL", true, true],
    ["Select", false, true],
    ["Status", false, false],
    ["Currency", false, false],
    ["Date", false, false],
    ["Checkbox", false, false],
    ["Rating", false, false],
  ])("%s: unique %s, multiple %s", async (label, hasUnique, hasMultiple) => {
    const { user } = await setup();
    await pick(user, label);
    expect(
      screen.getByRole("checkbox", { name: "Required" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Unique" }) !== null).toBe(
      hasUnique,
    );
    expect(
      screen.queryByRole("checkbox", { name: "Multiple values" }) !== null,
    ).toBe(hasMultiple);
  });

  it("shows the options editor only for select and status", async () => {
    const { user } = await setup();
    await pick(user, "Text");
    expect(screen.queryByRole("group", { name: "Options" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change type" }));
    await pick(user, "Status");
    expect(screen.getByRole("group", { name: "Options" })).toBeInTheDocument();
    expect(
      screen.getByText(/Defaults to To do, In progress, Done/),
    ).toBeInTheDocument();
  });

  it("shows the currency select only for currency", async () => {
    const { user } = await setup();
    await pick(user, "Currency");
    const currency = screen.getByRole("combobox", { name: "Currency" });
    expect(
      within(currency)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD"]);
  });

  it("keeps unique and multiple from being chosen together", async () => {
    const { user } = await setup();
    await pick(user, "Email");
    await user.click(screen.getByRole("checkbox", { name: "Unique" }));
    expect(
      screen.getByRole("checkbox", { name: "Multiple values" }),
    ).toBeDisabled();
  });
});

describe("<CreateAttributeDialog> creating", () => {
  it("refuses a select with no option and says why", async () => {
    const { user, client, objectType, onClose } = await setup();
    await pick(user, "Select");
    await user.type(screen.getByRole("textbox", { name: /^Name/ }), "Sector");
    await user.click(screen.getByRole("button", { name: "Add attribute" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A select attribute needs at least one option.",
    );
    expect(onClose).not.toHaveBeenCalled();
    const after = await typeByName(client, SPACE, objectType.name);
    expect(after.attributes).toHaveLength(objectType.attributes.length);
  });

  it("creates a select with ordered options", async () => {
    const { user, client, onClose } = await setup();
    await pick(user, "Select");
    await user.type(screen.getByRole("textbox", { name: /^Name/ }), "Sector");
    await user.click(screen.getByRole("button", { name: "Add option" }));
    await user.type(
      screen.getByRole("textbox", { name: "Option 1" }),
      "Fintech",
    );
    await user.click(screen.getByRole("button", { name: "Add option" }));
    await user.type(
      screen.getByRole("textbox", { name: "Option 2" }),
      "Climate",
    );
    await user.click(screen.getByRole("button", { name: "Move Climate up" }));
    await user.click(screen.getByRole("button", { name: "Add option" }));
    await user.click(screen.getByRole("button", { name: "Remove option 3" }));
    await user.click(screen.getByRole("button", { name: "Add attribute" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const firm = await typeByName(client, SPACE, "Firm");
    const sector = firm.attributes.find((item) => item.slug === "sector");
    expect(sector?.type).toBe("select");
    expect(sector?.options.map((option) => option.name)).toEqual([
      "Climate",
      "Fintech",
    ]);
  });

  it("lets a status attribute fall back to the default options", async () => {
    const { user, client, onClose } = await setup();
    await pick(user, "Status");
    await user.type(screen.getByRole("textbox", { name: /^Name/ }), "Coverage");
    await user.click(screen.getByRole("button", { name: "Add attribute" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const firm = await typeByName(client, SPACE, "Firm");
    expect(
      firm.attributes
        .find((item) => item.slug === "coverage")
        ?.options.map((option) => option.name),
    ).toEqual(["To do", "In progress", "Done"]);
  });

  it("shows a server error inline, e.g. a duplicate attribute name", async () => {
    const { user, onClose } = await setup();
    await pick(user, "Text");
    await user.type(screen.getByRole("textbox", { name: /^Name/ }), "domain");
    await user.click(screen.getByRole("button", { name: "Add attribute" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already has an attribute named "Domain"/,
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("<CreateAttributeDialog> relationship flow", () => {
  it("swaps to the relationship form, never offering the type itself", async () => {
    const { user } = await setup();
    await pick(user, "Relation");
    const target = screen.getByRole("combobox", { name: /Target object type/ });
    const names = within(target)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(names).toEqual(["Pick an object type", "Investor", "Meeting"]);
    expect(
      screen.getByText("Cardinality cannot be changed later."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });

  it("fills default names and a live preview, and follows cardinality", async () => {
    const { user } = await setup();
    await pick(user, "Relation");
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Target object type/ }),
      "Meeting",
    );
    const name = screen.getByRole("textbox", {
      name: /Attribute name on Firm/,
    });
    const inverse = screen.getByRole("textbox", {
      name: /Attribute name on Meeting/,
    });
    expect(name).toHaveValue("Meeting");
    expect(inverse).toHaveValue("Firms");
    expect(
      screen.getByText(
        "Each Firm links to one Meeting. Each Meeting lists many Firms.",
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("radio", { name: "One Link per Target" }),
    );
    expect(name).toHaveValue("Meetings");
    expect(inverse).toHaveValue("Firm");
    expect(
      screen.getByText(
        "Each Firm links to many Meetings. Each Meeting lists one Firm.",
      ),
    ).toBeInTheDocument();
  });

  it("creates both sides in one submit", async () => {
    const { user, client, onClose } = await setup();
    await pick(user, "Relation");
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Target object type/ }),
      "Meeting",
    );
    await user.click(
      screen.getByRole("radio", { name: "One Link per Target" }),
    );
    await user.click(screen.getByRole("button", { name: "Add attribute" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // Read back through a fresh schema fetch: both attributes exist and
    // point at each other.
    const schema = await client.getSchema(SPACE);
    const firm = schema.objectTypes.find((type) => type.name === "Firm");
    const meeting = schema.objectTypes.find((type) => type.name === "Meeting");
    const owning = firm?.attributes.find((item) => item.slug === "meetings");
    const mirrored = meeting?.attributes.find((item) => item.slug === "firm");
    expect(owning?.relationship).toMatchObject({
      targetTypeId: meeting?.id,
      cardinality: "one_to_many",
      inverseAttributeId: mirrored?.id,
    });
    expect(mirrored?.relationship).toMatchObject({
      targetTypeId: firm?.id,
      cardinality: "many_to_one",
      inverseAttributeId: owning?.id,
      relationshipId: owning?.relationship?.relationshipId,
    });
  });

  it("skips the inverse attribute when the checkbox is off", async () => {
    const { user, client, onClose } = await setup();
    const before = await typeByName(client, SPACE, "Meeting");
    await pick(user, "Relation");
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Target object type/ }),
      "Meeting",
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "Also add an attribute on Meeting",
      }),
    );
    expect(
      screen.queryByRole("textbox", { name: /Attribute name on Meeting/ }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add attribute" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    const after = await typeByName(client, SPACE, "Meeting");
    expect(after.attributes).toHaveLength(before.attributes.length);
    const firm = await typeByName(client, SPACE, "Firm");
    expect(
      firm.attributes.find((item) => item.slug === "meeting")?.relationship
        ?.inverseAttributeId,
    ).toBeNull();
  });

  it("asks for a target before it submits", async () => {
    const { user, onClose } = await setup();
    await pick(user, "Relation");
    await user.click(screen.getByRole("button", { name: "Add attribute" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pick a target object type.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
