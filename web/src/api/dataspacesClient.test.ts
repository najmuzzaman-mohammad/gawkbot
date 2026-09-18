import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./client";
import { DataValidationError } from "./dataspaces";
import { createBrokerDataClient } from "./dataspacesClient";

// The real `client.ts` transport is replaced, not `fetch`: the contract this
// file pins is "what the broker-backed client does with what client.ts hands
// it", and client.ts already has its own tests for turning a Response into an
// ApiError. ApiError itself stays the real class, because `instanceof` is the
// branch under test.
const { get, patch, post } = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, get, patch, post };
});

function apiError(status: number, body: unknown): ApiError {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return new ApiError({ status, statusText: "", bodyText });
}

const client = createBrokerDataClient();

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  post.mockReset();
});

describe("broker DataClient error mapping", () => {
  it("turns a 400 carrying an attribute into a DataValidationError on that attribute", async () => {
    patch.mockRejectedValueOnce(
      apiError(400, {
        error: '"urgent" is not an option. Valid options: Low, Medium, High.',
        attribute: "priority",
      }),
    );

    const caught = await client
      .updateRecord("space_1", "rec_1", { priority: "urgent" })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DataValidationError);
    const failure = caught as DataValidationError;
    // The message is the broker's, not ApiError's humanized wrapper, so the
    // valid options survive to the field.
    expect(failure.message).toContain("Valid options: Low, Medium, High.");
    expect(failure.attribute).toBe("priority");
  });

  it("turns a 400 without an attribute into a DataValidationError with none", async () => {
    post.mockRejectedValueOnce(apiError(400, { error: "Name is required." }));

    const caught = await client
      .createObjectType("space_1", { name: "" })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DataValidationError);
    expect((caught as DataValidationError).attribute).toBeNull();
  });

  // SpaceLoadError renders "not found" for a DataValidationError and a generic
  // failure for anything else, so a 404 must arrive as the former.
  it("turns a 404 into a DataValidationError", async () => {
    get.mockRejectedValueOnce(apiError(404, { error: "not found" }));

    const caught = await client
      .getSchema("space_missing")
      .then(() => null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DataValidationError);
  });

  it("turns a 403 into a DataValidationError naming the owner", async () => {
    post.mockRejectedValueOnce(
      apiError(403, {
        error:
          "read-only access to this data space; @cos owns it and can grant write access",
      }),
    );

    const caught = await client
      .createRecord("space_1", "type_1", { name: "Ada" })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DataValidationError);
    expect((caught as DataValidationError).message).toContain("@cos");
  });

  // 429 and 5xx are "try again", not "you typed something wrong". The hooks'
  // retry gate keys on DataValidationError, so mistranslating these would stop
  // a transient failure from ever being retried.
  it.each([429, 500, 503])("leaves a %i as an ApiError", async (status) => {
    get.mockRejectedValueOnce(apiError(status, { error: "rate limited" }));

    const caught = await client
      .listSpaces()
      .then(() => null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(DataValidationError);
  });

  it("keeps the humanized message when a 400 body is not JSON", async () => {
    patch.mockRejectedValueOnce(apiError(400, "something went wrong"));

    const caught = await client
      .updateRecord("space_1", "rec_1", {})
      .then(() => null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DataValidationError);
    expect((caught as DataValidationError).message).toBe(
      "something went wrong",
    );
  });

  // A batch answers 200 even when an item failed, so the failure is inside the
  // envelope. These single-item methods send one item, so one failed entry is
  // the call failing — and its attribute still has to reach the field.
  it("raises a failed batch entry out of a 200 envelope", async () => {
    post.mockResolvedValueOnce({
      succeeded: 0,
      failed: 1,
      summary: "0 created, 1 failed",
      entries: [
        {
          index: 0,
          status: "failed",
          error: '"urgent" is not an option.',
          attribute: "stage",
        },
      ],
    });

    const caught = await client
      .createRecord("space_1", "type_1", { stage: "urgent" })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DataValidationError);
    expect((caught as DataValidationError).attribute).toBe("stage");
    // The failure is raised before the follow-up read, so no record is fetched.
    expect(get).not.toHaveBeenCalled();
  });
});

/** The minimum a `/data/spaces/<id>` answer carries for the space itself. */
function baseWireSpace() {
  return {
    id: "space_1",
    name: "Seed raise",
    owner: "cos",
    access: { scope: "private", grants: [] },
    object_type_count: 0,
    record_count: 0,
    created_at: "2026-09-17T10:00:00.000Z",
    updated_at: "2026-09-17T10:00:00.000Z",
    caller_level: "write",
  };
}

describe("broker DataClient wire mapping", () => {
  it("maps a snake_case space onto the camelCase model", async () => {
    get.mockResolvedValueOnce({
      spaces: [
        {
          id: "space_1",
          name: "Seed raise",
          owner: "cos",
          access: { scope: "shared", grants: [{ bot: "ops", level: "read" }] },
          object_type_count: 3,
          record_count: 42,
          attached_app_ids: ["app_0123456789abcdef"],
          created_at: "2026-09-17T10:00:00.000Z",
          updated_at: "2026-09-17T11:00:00.000Z",
          caller_level: "read",
        },
      ],
    });

    const [space] = await client.listSpaces();

    expect(get).toHaveBeenCalledWith("/data/spaces");
    expect(space).toEqual({
      id: "space_1",
      name: "Seed raise",
      // Absent on the wire (omitempty) and required by the model.
      description: "",
      owner: "cos",
      access: { scope: "shared", grants: [{ bot: "ops", level: "read" }] },
      objectTypeCount: 3,
      recordCount: 42,
      attachedAppIds: ["app_0123456789abcdef"],
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T11:00:00.000Z",
      // The store says what this caller may do; the UI used to drop it and
      // then offer writes it could not perform.
      callerLevel: "read",
    });
  });

  it("assumes write when a broker does not send caller_level", async () => {
    get.mockResolvedValueOnce({
      spaces: [
        {
          id: "space_1",
          name: "Seed raise",
          owner: "cos",
          access: { scope: "private", grants: [] },
          object_type_count: 0,
          record_count: 0,
          created_at: "2026-09-17T10:00:00.000Z",
          updated_at: "2026-09-17T11:00:00.000Z",
        },
      ],
    });

    const [space] = await client.listSpaces();

    expect(space.callerLevel).toBe("write");
  });

  it("narrows a caller level it does not know rather than passing it through", async () => {
    get.mockResolvedValueOnce({
      spaces: [
        {
          id: "space_1",
          name: "Seed raise",
          owner: "cos",
          access: { scope: "private", grants: [] },
          object_type_count: 0,
          record_count: 0,
          created_at: "2026-09-17T10:00:00.000Z",
          updated_at: "2026-09-17T11:00:00.000Z",
          caller_level: "append_only",
        },
      ],
    });

    const [space] = await client.listSpaces();

    expect(space.callerLevel).toBe("write");
  });

  it("maps an object type and its relationship attribute", async () => {
    get.mockResolvedValueOnce({
      space: {
        id: "space_1",
        name: "Seed raise",
        owner: "cos",
        access: { scope: "private", grants: [] },
        object_type_count: 1,
        record_count: 0,
        created_at: "2026-09-17T10:00:00.000Z",
        updated_at: "2026-09-17T10:00:00.000Z",
      },
      object_types: [
        {
          id: "type_1",
          slug: "investor",
          name: "Investor",
          name_plural: "Investors",
          record_count: 2,
          created_by: "cos",
          created_at: "2026-09-17T10:00:00.000Z",
          attributes: [
            {
              id: "attr_1",
              slug: "firm",
              name: "Firm",
              type: "relationship",
              is_primary: false,
              is_required: false,
              is_unique: false,
              is_multivalue: false,
              created_by: "cos",
              relationship: {
                relationship_id: "rel_1",
                target_type_id: "type_2",
                cardinality: "many_to_one",
                inverse_attribute_id: "attr_9",
              },
            },
          ],
        },
      ],
    });

    const schema = await client.getSchema("space_1");

    expect(get).toHaveBeenCalledWith("/data/spaces/space_1");
    const [attribute] = schema.objectTypes[0].attributes;
    expect(schema.objectTypes[0].namePlural).toBe("Investors");
    expect(attribute.relationship).toEqual({
      relationshipId: "rel_1",
      targetTypeId: "type_2",
      cardinality: "many_to_one",
      inverseAttributeId: "attr_9",
    });
    // An absent inverse must read as null, never undefined.
    expect(attribute.currencyCode).toBeNull();
  });

  it("maps the schema's own relationship rows, which say who owns each pair", async () => {
    get.mockResolvedValueOnce({
      space: baseWireSpace(),
      object_types: [],
      relationships: [
        {
          id: "rel_1",
          source_type_id: "type_1",
          source_attribute_id: "attr_1",
          target_type_id: "type_2",
          inverse_attribute_id: "attr_9",
          cardinality: "many_to_one",
        },
        {
          id: "rel_2",
          source_type_id: "type_2",
          source_attribute_id: "attr_5",
          target_type_id: "type_3",
          cardinality: "one_to_many",
        },
      ],
    });

    const schema = await client.getSchema("space_1");

    expect(schema.relationships).toEqual([
      {
        id: "rel_1",
        sourceTypeId: "type_1",
        sourceAttributeId: "attr_1",
        targetTypeId: "type_2",
        inverseAttributeId: "attr_9",
        cardinality: "many_to_one",
      },
      {
        id: "rel_2",
        sourceTypeId: "type_2",
        sourceAttributeId: "attr_5",
        targetTypeId: "type_3",
        // Absent on the wire (omitempty) must read as null, never undefined.
        inverseAttributeId: null,
        cardinality: "one_to_many",
      },
    ]);
  });

  // Undefined and empty are different answers: only the first may fall back
  // to inferring the owning side from the two attributes.
  it("leaves relationships undefined when the broker does not send them", async () => {
    get.mockResolvedValueOnce({ space: baseWireSpace(), object_types: [] });

    const schema = await client.getSchema("space_1");

    expect(schema.relationships).toBeUndefined();
  });

  it("narrows an option color and a cardinality it does not know", async () => {
    get.mockResolvedValueOnce({
      space: baseWireSpace(),
      object_types: [
        {
          id: "type_1",
          slug: "investor",
          name: "Investor",
          name_plural: "Investors",
          record_count: 0,
          created_by: "cos",
          created_at: "2026-09-17T10:00:00.000Z",
          attributes: [
            {
              id: "attr_1",
              slug: "stage",
              name: "Stage",
              type: "status",
              is_primary: false,
              is_required: false,
              is_unique: false,
              is_multivalue: false,
              created_by: "cos",
              options: [{ id: "opt_1", name: "Pitched", color: "chartreuse" }],
            },
            {
              id: "attr_2",
              slug: "firm",
              name: "Firm",
              type: "relationship",
              is_primary: false,
              is_required: false,
              is_unique: false,
              is_multivalue: false,
              created_by: "cos",
              relationship: {
                relationship_id: "rel_1",
                target_type_id: "type_2",
                cardinality: "many_to_several",
              },
            },
          ],
        },
      ],
    });

    const schema = await client.getSchema("space_1");
    const [stage, firm] = schema.objectTypes[0].attributes;

    // A color slot with no CSS behind it renders as the neutral one.
    expect(stage.options[0].color).toBe("neutral");
    // The permissive shape: an unknown cardinality must never have the UI
    // claim a to-one limit the store may not enforce.
    expect(firm.relationship?.cardinality).toBe("many_to_many");
  });

  it("sends a query with sort direction flattened to the wire's desc flag", async () => {
    post.mockResolvedValueOnce({ records: [], total: 0 });

    await client.queryRecords("space_1", {
      typeId: "type_1",
      filters: [{ attribute: "stage", operator: "equals", value: "Pitched" }],
      sort: { attribute: "name", direction: "desc" },
      query: "ada",
      limit: 30,
      offset: 60,
    });

    expect(post).toHaveBeenCalledWith("/data/spaces/space_1/records/query", {
      object_type: "type_1",
      filters: [{ attribute: "stage", operator: "equals", value: "Pitched" }],
      sort: { attribute: "name", desc: true },
      query: "ada",
      limit: 30,
      offset: 60,
    });
  });

  it("re-reads the record after a link so the caller sees the new chip", async () => {
    post.mockResolvedValueOnce({
      succeeded: 1,
      failed: 0,
      summary: "1 linked",
      entries: [{ index: 0, status: "ok", id: "rec_1" }],
    });
    get.mockResolvedValueOnce({
      record: {
        id: "rec_1",
        type_id: "type_1",
        values: { name: "Ada" },
        links: { firm: [{ id: "rec_2", type_id: "type_2", name: "Acme" }] },
        created_by: "cos",
        created_at: "2026-09-17T10:00:00.000Z",
        updated_at: "2026-09-17T12:00:00.000Z",
      },
    });

    const record = await client.linkRecords(
      "space_1",
      "rec_1",
      "firm",
      "rec_2",
      true,
    );

    expect(post).toHaveBeenCalledWith("/data/spaces/space_1/links", {
      items: [
        { record: "rec_1", attribute: "firm", target: "rec_2", replace: true },
      ],
    });
    expect(get).toHaveBeenCalledWith("/data/spaces/space_1/records/rec_1");
    expect(record.links.firm).toEqual([
      { id: "rec_2", typeId: "type_2", name: "Acme" },
    ]);
  });

  it("percent-encodes ids so a stray slash cannot walk the route", async () => {
    get.mockResolvedValueOnce({
      record: {
        id: "rec/1",
        type_id: "type_1",
        created_by: "human",
        created_at: "",
        updated_at: "",
      },
    });

    await client.getRecord("space_1", "rec/1");

    expect(get).toHaveBeenCalledWith("/data/spaces/space_1/records/rec%2F1");
  });
});
