/**
 * One walkthrough per ICP tutorial example in docs/specs/agent-data-model.md,
 * driven through the client API against a fresh empty space. Steps that need
 * a bot, the UI, or the app bridge (slices S3 to S5) are covered here only as
 * far as the data layer goes; each test says where it stops.
 */

import { describe, expect, it } from "vitest";

import {
  defaultFixtureSpaces,
  RECRUITING_SPACE_ID,
} from "./dataspaces.fixtures";
import { createTestKit, validationError } from "./dataspaces.mock.testkit";

describe("ICP 1: Sam's seed raise tracker", () => {
  it("builds the schema, fills it without duplicates, and reads it back sorted and linked", async () => {
    const kit = createTestKit();
    const { client, spaceId } = kit;

    // Step 1: the bot checks existing types, finds none, and creates three.
    expect((await client.getSchema(spaceId)).objectTypes).toEqual([]);
    const investor = await kit.type("Investor");
    await kit.attr(investor.id, {
      name: "Email",
      type: "email",
      isUnique: true,
    });
    await kit.attr(investor.id, {
      name: "Stage",
      type: "status",
      options: ["Intro", "Pitched", "Diligence", "Committed", "Passed"],
    });
    await kit.attr(investor.id, { name: "Check size", type: "currency" });
    const firm = await kit.type("Firm");
    await kit.attr(firm.id, { name: "Domain", type: "text", isUnique: true });
    await kit.attr(firm.id, {
      name: "Tier",
      type: "select",
      options: ["Tier 1", "Tier 2"],
    });
    const meeting = await kit.type("Meeting");
    await kit.attr(meeting.id, { name: "Date", type: "date" });
    await kit.attr(meeting.id, { name: "Notes", type: "text" });

    // Step 2: relationship fields, each with its inverse.
    await kit.relate(investor.id, "Firm", firm.id, "many_to_one", "Investors");
    await kit.relate(
      meeting.id,
      "Investor",
      investor.id,
      "many_to_one",
      "Meetings",
    );

    // Step 3: re-read the schema, then create records from the notes.
    const schema = await client.getSchema(spaceId);
    expect(schema.objectTypes.map((type) => type.namePlural)).toEqual([
      "Investors",
      "Firms",
      "Meetings",
    ]);
    const investorSlugs = (await kit.readType(investor.id)).attributes.map(
      (a) => a.slug,
    );
    expect(investorSlugs).toEqual([
      "name",
      "email",
      "stage",
      "check_size",
      "firm",
      "meetings",
    ]);

    const tidewrack = await client.createRecord(spaceId, firm.id, {
      name: "Tidewrack Capital",
      domain: "tidewrack.example",
      tier: "Tier 1",
    });
    const notes = [
      ["Mirela Okonjo-Hart", "mirela@tidewrack.example", "Pitched", 250000],
      ["Tobias Vandersloot", "tobias@tidewrack.example", "Intro", null],
      ["Anneke Brightwater", "anneke@halcyonspur.example", "Committed", 100000],
    ] as const;
    const ids: string[] = [];
    for (const [name, email, stage, check_size] of notes) {
      const record = await client.createRecord(spaceId, investor.id, {
        name,
        email,
        stage,
        check_size,
      });
      ids.push(record.id);
    }
    await client.linkRecords(spaceId, ids[0], "firm", tidewrack.id);
    await client.linkRecords(spaceId, ids[1], "firm", tidewrack.id);

    // A second run does not duplicate: the unique email names the existing
    // record, which is the id an upsert updates instead.
    const rerun = await validationError(
      client.createRecord(spaceId, investor.id, {
        name: "Mirela Okonjo-Hart",
        email: "Mirela@Tidewrack.example",
      }),
    );
    expect(rerun.attribute).toBe("email");
    expect(rerun.message).toContain(ids[0]);
    await client.updateRecord(spaceId, ids[0], { stage: "Diligence" });
    expect((await kit.readType(investor.id)).recordCount).toBe(3);

    for (const [title, date] of [
      ["Intro call", "2026-07-02"],
      ["Partner meeting", "2026-08-11T16:00:00Z"],
    ]) {
      const record = await client.createRecord(spaceId, meeting.id, {
        name: title,
        date,
      });
      await client.linkRecords(spaceId, record.id, "investor", ids[0]);
    }

    // Step 4: Investors table sorted by stage, then the record page.
    const table = await client.queryRecords(spaceId, {
      typeId: investor.id,
      sort: { attribute: "stage", direction: "asc" },
      limit: 30,
      offset: 0,
    });
    expect(table.records.map((record) => record.values.name)).toEqual([
      "Tobias Vandersloot",
      "Mirela Okonjo-Hart",
      "Anneke Brightwater",
    ]);
    const page = await client.getRecord(spaceId, ids[0]);
    expect(page.links.firm.map((ref) => ref.name)).toEqual([
      "Tidewrack Capital",
    ]);
    expect(page.links.meetings.map((ref) => ref.name)).toEqual([
      "Intro call",
      "Partner meeting",
    ]);

    // Step 5, data layer only: a stage change written through the same
    // client (what the app bridge will call in S5) shows in the table query.
    await client.updateRecord(spaceId, ids[1], { stage: "Passed" });
    const after = await client.queryRecords(spaceId, {
      typeId: investor.id,
      filters: [{ attribute: "stage", operator: "equals", value: "Passed" }],
      limit: 30,
      offset: 0,
    });
    expect(after.records.map((record) => record.id)).toEqual([ids[1]]);
  });
});

describe("ICP 2: Priya's client delivery tracker", () => {
  it("edits a due date, adds a priority field to the existing type, and self-corrects a bad option", async () => {
    const kit = createTestKit();
    const { client, spaceId } = kit;

    // Step 1.
    const clientType = await kit.type("Client");
    const project = await kit.type("Project");
    await kit.attr(project.id, { name: "Status", type: "status" });
    await kit.attr(project.id, { name: "Budget", type: "currency" });
    await kit.relate(
      project.id,
      "Client",
      clientType.id,
      "many_to_one",
      "Projects",
    );
    const deliverable = await kit.type("Deliverable");
    await kit.attr(deliverable.id, { name: "Due date", type: "date" });
    await kit.attr(deliverable.id, { name: "Done", type: "toggle" });
    await kit.attr(deliverable.id, { name: "Owner", type: "text" });
    await kit.relate(
      deliverable.id,
      "Project",
      project.id,
      "many_to_one",
      "Deliverables",
    );

    const larkspur = await client.createRecord(spaceId, clientType.id, {
      name: "Larkspur Dental Group",
    });
    const rebuild = await client.createRecord(spaceId, project.id, {
      name: "Patient booking flow redesign",
      status: "In progress",
      budget: "48000",
    });
    await client.linkRecords(spaceId, rebuild.id, "client", larkspur.id);
    const copyDeck = await client.createRecord(spaceId, deliverable.id, {
      name: "Copy deck",
      due_date: "2026-10-01",
      done: false,
      owner: "Priya",
    });
    await client.linkRecords(spaceId, copyDeck.id, "project", rebuild.id);

    // Step 2: the inline due date edit persists and shows under the project.
    const edited = await client.updateRecord(spaceId, copyDeck.id, {
      due_date: "2026-10-15",
    });
    expect(edited.values.due_date).toBe("2026-10-15");
    const projectPage = await client.getRecord(spaceId, rebuild.id);
    expect(projectPage.links.deliverables.map((ref) => ref.id)).toEqual([
      copyDeck.id,
    ]);
    const related = await client.getRecord(
      spaceId,
      projectPage.links.deliverables[0].id,
    );
    expect(related.values.due_date).toBe("2026-10-15");

    // Step 3: one select attribute on the existing type; no second type.
    const second = await validationError(kit.type("deliverable"));
    expect(second.message).toContain("Add attributes to it instead");
    const priority = await kit.attr(deliverable.id, {
      name: "Priority",
      type: "select",
      options: ["low", "medium", "high"],
    });
    const schema = await client.getSchema(spaceId);
    expect(
      schema.objectTypes.filter((type) => type.name === "Deliverable"),
    ).toHaveLength(1);
    expect(
      (await kit.readType(deliverable.id)).attributes.map((a) => a.slug),
    ).toContain("priority");

    // Step 4: "urgent" is refused with the valid options; the bot maps to high.
    const urgent = await validationError(
      client.updateRecord(spaceId, copyDeck.id, { priority: "urgent" }),
    );
    expect(urgent.message).toBe(
      '"urgent" is not a valid option for Priority. Valid options: low, medium, high.',
    );
    const mapped = await client.updateRecord(spaceId, copyDeck.id, {
      priority: "high",
    });
    expect(mapped.values.priority).toBe(priority.options[2].id);
  });
});

describe("ICP 3: Marcus's recruiting pipeline", () => {
  it("rejects a rating of 7, keeps a candidate on one role, and previews the Interview delete", async () => {
    // The other use cases of the office live next door, in their own spaces.
    const kit = createTestKit({
      spaces: defaultFixtureSpaces(),
      emptySpace: true,
    });
    const { client, spaceId } = kit;
    const neighborsBefore = (await client.listSpaces()).filter(
      (space) => space.id !== spaceId,
    );
    expect(neighborsBefore).toHaveLength(4);

    // Step 1.
    const role = await kit.type("Role");
    const candidate = await kit.type("Candidate");
    await kit.attr(candidate.id, {
      name: "Email",
      type: "email",
      isUnique: true,
    });
    await kit.attr(candidate.id, { name: "Stage", type: "status" });
    await kit.relate(
      candidate.id,
      "Role",
      role.id,
      "many_to_one",
      "Candidates",
    );
    const interview = await kit.type("Interview");
    await kit.attr(interview.id, { name: "Date", type: "date" });
    await kit.attr(interview.id, { name: "Rating", type: "rating" });
    await kit.attr(interview.id, { name: "Interviewer", type: "text" });
    await kit.relate(
      interview.id,
      "Candidate",
      candidate.id,
      "many_to_one",
      "Interviews",
    );

    const roleIds: string[] = [];
    for (const name of [
      "Senior Backend Engineer",
      "Product Designer",
      "Customer Success Lead",
    ]) {
      roleIds.push((await client.createRecord(spaceId, role.id, { name })).id);
    }
    const freya = await client.createRecord(spaceId, candidate.id, {
      name: "Freya Lindahl",
      email: "freya.lindahl@postbox.example",
      stage: "To do",
    });
    await client.linkRecords(spaceId, freya.id, "role", roleIds[0]);

    // Step 2: rating 7 is rejected clearly; 4 is fine.
    const tooHigh = await validationError(
      client.createRecord(spaceId, interview.id, {
        name: "Onsite panel",
        rating: 7,
      }),
    );
    expect(tooHigh.message).toBe(
      "Rating must be a whole number from 1 to 5; got 7.",
    );
    const onsite = await client.createRecord(spaceId, interview.id, {
      name: "Onsite panel",
      date: "2026-09-03",
      rating: 4,
      interviewer: "Dana Whitlock-Ames",
    });
    await client.linkRecords(spaceId, onsite.id, "candidate", freya.id);

    // A candidate cannot be on two roles; replace moves them.
    const twoRoles = await validationError(
      client.linkRecords(spaceId, freya.id, "role", roleIds[1]),
    );
    expect(twoRoles.message).toContain(
      "Freya Lindahl is already linked to Senior Backend Engineer",
    );
    const moved = await client.linkRecords(
      spaceId,
      freya.id,
      "role",
      roleIds[1],
      true,
    );
    expect(moved.links.role.map((ref) => ref.name)).toEqual([
      "Product Designer",
    ]);
    const oldRole = await client.getRecord(spaceId, roleIds[0]);
    expect(oldRole.links.candidates).toEqual([]);

    // Step 3: the preview shows counts, and nothing is removed until execute.
    const preview = await client.previewDelete(spaceId, "object_type", [
      interview.id,
    ]);
    expect(preview.impact).toEqual({
      records: 1,
      links: 1,
      attributes: 6,
      objectTypes: 1,
    });
    expect((await client.getSchema(spaceId)).objectTypes).toHaveLength(3);
    await client.executeDelete(spaceId, preview.token);
    const schema = await client.getSchema(spaceId);
    expect(schema.objectTypes.map((type) => type.name)).toEqual([
      "Role",
      "Candidate",
    ]);
    expect(
      (await kit.readType(candidate.id)).attributes.map((a) => a.slug),
    ).toEqual(["name", "email", "stage", "role"]);

    // Step 4: the use case lives in its own space; others are untouched.
    const neighborsAfter = (await client.listSpaces()).filter(
      (space) => space.id !== spaceId,
    );
    expect(neighborsAfter).toEqual(neighborsBefore);
    const recruitingFixture = await client.getSchema(RECRUITING_SPACE_ID);
    expect(recruitingFixture.objectTypes.map((type) => type.name)).toContain(
      "Interview",
    );
    const crossSpace = await validationError(
      client.getRecord(RECRUITING_SPACE_ID, freya.id),
    );
    expect(crossSpace.message).toContain("Unknown record");
  });
});
