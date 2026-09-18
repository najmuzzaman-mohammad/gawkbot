/**
 * ICP example 2: Priya's client delivery tracker, owned by the `ops` bot.
 * Every client, person, and domain here is invented.
 */

import {
  createRandom,
  createSpaceBuilder,
  pick,
} from "./dataspaces.fixtures.builder";
import { ACTOR_HUMAN, type SpaceState } from "./dataspaces.mock.store";

export const CLIENT_DELIVERY_SPACE_ID = "space_client_delivery";
export const DELIVERABLE_PRIORITIES = ["low", "medium", "high"] as const;
export const PROJECT_STATUSES = [
  "Planned",
  "Active",
  "On hold",
  "Delivered",
] as const;

type ClientRow = readonly [name: string, domain: string, industry: string];
const CLIENTS: readonly ClientRow[] = [
  ["Larkspur Dental Group", "larkspurdental.example", "Healthcare"],
  ["Brindle and Oak Furniture", "brindleoak.example", "Retail"],
  ["Fennwick Logistics", "fennwick.example", "Logistics"],
  ["Solstice Yoga Collective", "solsticeyoga.example", "Wellness"],
  ["Harrowgate Brewing", "harrowgatebrewing.example", "Hospitality"],
  ["Pipistrelle Books", "pipistrellebooks.example", "Retail"],
  ["Maplethorn Veterinary", "maplethornvet.example", "Healthcare"],
  // Signed last week: no projects yet, so its Projects list renders empty.
  ["Cinderford Cycles", "cinderfordcycles.example", ""],
];

type ProjectRow = readonly [
  name: string,
  client: number,
  status: string,
  budget: number | null,
  health: number | null,
];
const PROJECTS: readonly ProjectRow[] = [
  ["Patient booking flow redesign", 0, "Active", 48_000, 4],
  ["Larkspur brand refresh", 0, "Delivered", 22_500, 5],
  ["Brindle and Oak storefront rebuild", 1, "Active", 86_000, 3],
  ["Spring lookbook microsite", 1, "Planned", 14_000, null],
  ["Fennwick driver portal", 2, "Active", 120_000, 2],
  ["Fleet dashboard discovery", 2, "On hold", null, 2],
  ["Class pass checkout", 3, "Active", 31_000, 4],
  ["Taproom events calendar", 4, "Delivered", 18_000, 5],
  ["Harrowgate loyalty program", 4, "Planned", 27_500, null],
  ["Pipistrelle preorder pages", 5, "Active", 12_000, 4],
  ["Maplethorn client reminders", 6, "On hold", 40_000, 3],
  ["Maplethorn online pharmacy", 6, "Planned", null, null],
];

const DELIVERABLES = [
  "Discovery workshop",
  "Sitemap and wireframes",
  "Visual design round 1",
  "Copy deck",
  "Staging build",
  "Analytics setup",
  "Launch checklist",
  "Handover training",
];
const OWNERS = ["Priya", "Tomasz", "Ngozi", "Ilse"];
const DELIVERABLE_COUNT = 28;

export function buildClientDeliverySpace(): SpaceState {
  const random = createRandom(4102);
  const b = createSpaceBuilder({
    id: CLIENT_DELIVERY_SPACE_ID,
    key: "delivery",
    name: "Client delivery",
    description: "Clients, their projects, and what is due when.",
    owner: "ops",
    access: { scope: "shared", grants: [{ bot: "cos", level: "read" }] },
    startAt: "2026-05-11T14:30:00.000Z",
  });

  const client = b.type({
    name: "Client",
    icon: "briefcase",
    description: "A company the agency works for.",
  });
  b.attribute(client, { name: "Website", type: "url" });
  b.attribute(client, { name: "Contact email", type: "email" });
  b.attribute(client, {
    name: "Industry",
    type: "select",
    options: ["Healthcare", "Retail", "Logistics", "Wellness", "Hospitality"],
  });

  const project = b.type({
    name: "Project",
    icon: "folder",
    description: "A scoped engagement for one client.",
  });
  b.attribute(project, {
    name: "Status",
    type: "status",
    options: PROJECT_STATUSES,
  });
  b.attribute(project, {
    name: "Budget",
    type: "currency",
    currencyCode: "USD",
  });
  b.attribute(project, { name: "Health", type: "rating" }, ACTOR_HUMAN);
  b.attribute(project, {
    name: "Client",
    type: "relationship",
    relationship: {
      targetTypeId: client,
      cardinality: "many_to_one",
      inverseName: "Projects",
    },
  });

  const deliverable = b.type({
    name: "Deliverable",
    icon: "check-circle",
    description: "One thing owed to a client, with a due date.",
  });
  b.attribute(deliverable, { name: "Due date", type: "date" });
  b.attribute(deliverable, { name: "Done", type: "toggle" });
  b.attribute(deliverable, {
    name: "Priority",
    type: "select",
    options: DELIVERABLE_PRIORITIES,
  });
  b.attribute(deliverable, { name: "Owner", type: "text" });
  b.attribute(deliverable, {
    name: "Project",
    type: "relationship",
    relationship: {
      targetTypeId: project,
      cardinality: "many_to_one",
      inverseName: "Deliverables",
    },
  });

  const clientIds = CLIENTS.map(([name, domain, industry], index) =>
    b.record(
      client,
      {
        name,
        website: `https://www.${domain}`,
        // A couple of clients have no contact on file yet.
        contact_email: index % 4 === 3 ? null : `hello@${domain}`,
        industry: industry === "" ? null : industry,
      },
      index % 3 === 0 ? ACTOR_HUMAN : "ops",
    ),
  );

  const projectIds = PROJECTS.map(
    ([name, clientIndex, status, budget, health]) => {
      const id = b.record(project, { name, status, budget, health });
      b.link(id, "client", clientIds[clientIndex]);
      return id;
    },
  );

  for (let index = 0; index < DELIVERABLE_COUNT; index += 1) {
    const projectIndex = index % PROJECTS.length;
    const title = DELIVERABLES[index % DELIVERABLES.length];
    const day = String(1 + Math.floor(random() * 28)).padStart(2, "0");
    const month = String(8 + (index % 3)).padStart(2, "0");
    const id = b.record(
      deliverable,
      {
        name: `${title} (${PROJECTS[projectIndex][0]})`,
        due_date: random() < 0.85 ? `2026-${month}-${day}` : null,
        done: random() < 0.35,
        priority: random() < 0.8 ? pick(random, DELIVERABLE_PRIORITIES) : null,
        owner: random() < 0.75 ? pick(random, OWNERS) : null,
      },
      random() < 0.3 ? ACTOR_HUMAN : "ops",
    );
    b.link(id, "project", projectIds[projectIndex]);
  }

  return b.done();
}
