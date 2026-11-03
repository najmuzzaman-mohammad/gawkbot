/**
 * ICP example 1: Sam's seed raise tracker, owned by the `cos` bot.
 * Every person, firm, and domain here is invented.
 */

import {
  createRandom,
  createSpaceBuilder,
  pick,
} from "./dataspaces.fixtures.builder";
import { ACTOR_HUMAN, type SpaceState } from "./dataspaces.mock.store";

export const SEED_RAISE_SPACE_ID = "space_seed_raise";
export const SEED_RAISE_STAGES = [
  "Intro",
  "Pitched",
  "Diligence",
  "Committed",
  "Passed",
] as const;

const FIRMS: readonly (readonly [
  name: string,
  domain: string,
  tier: string,
])[] = [
  ["Tidewrack Capital", "tidewrack.example", "Tier 1"],
  ["Halcyon Spur Ventures", "halcyonspur.example", "Tier 1"],
  ["Northlantern Partners", "northlantern.example", "Tier 2"],
  ["Emberquill Ventures", "emberquill.example", "Tier 2"],
  ["Quillon and Vane", "quillonvane.example", "Tier 1"],
  ["Saltmarrow Ventures", "saltmarrow.example", "Tier 3"],
  ["Juniper Latch Capital", "juniperlatch.example", "Tier 2"],
  ["Pennywhistle Seed", "pennywhistle.example", "Tier 3"],
  ["Marrowstone Row", "marrowstonerow.example", "Tier 2"],
  ["Copperfold Capital", "copperfold.example", "Tier 3"],
  ["Windrose Tack Fund", "windrosetack.example", ""],
  ["Oddfellow Yard Ventures", "oddfellowyard.example", ""],
];

/** Angels carry no firm, so the Firm cell renders its empty state. */
const INVESTORS: readonly (readonly [name: string, firm: number | null])[] = [
  ["Mirela Okonjo-Hart", 0],
  ["Tobias Vandersloot", 0],
  ["Anneke Brightwater", 1],
  ["Desmond Achterberg", 1],
  ["Priyanka Velloor", 2],
  ["Callum Eastgrove", 2],
  ["Noor Haddadine", 3],
  ["Ezekiel Marchetti-Low", 3],
  ["Sunniva Dalgaard", 4],
  ["Rafael Quintanilha", 4],
  ["Imogen Thistlewood", 5],
  ["Kwabena Ofori-Lind", 6],
  ["Lucinda Parrish-Vale", 6],
  ["Hiroto Kanemaru", 7],
  ["Beatrix Holloway-Ng", 8],
  ["Oskar Lindqvist-Roy", 8],
  ["Temperance Adeyemi", 9],
  ["Giacomo Ferrante", 10],
  ["Wilhelmina Storrs", null],
  ["Jasper Okafor-Reyes", null],
  ["Leilani Kahananui", null],
  ["Dmitri Volkonsky-Hale", 11],
];

const CHECK_SIZES = [
  25_000, 50_000, 100_000, 150_000, 250_000, 400_000, 500_000,
];
const MEETING_KINDS = [
  "Intro call",
  "Pitch",
  "Partner meeting",
  "Diligence review",
  "Follow-up",
];
const MEETING_NOTES = [
  "Liked the wedge. Wants to see retention by cohort before the next call.",
  "Asked about pricing and whether the office can run unattended overnight.",
  "Pushed on market size. Will intro us to two portfolio founders.",
  "Wants a reference call with a design partner.",
  "Sent the data room link. They will circle back after Monday partners.",
];
const MEETING_COUNT = 30;
const UNLINKED_MEETINGS = 2;

function handle(name: string): string {
  return name.split(" ")[0].toLowerCase();
}

function surnameDomain(name: string): string {
  const surname = name.split(" ").slice(1).join("");
  return `${surname.toLowerCase().replace(/[^a-z]/g, "")}.example`;
}

export function buildSeedRaiseSpace(): SpaceState {
  const random = createRandom(20260917);
  const b = createSpaceBuilder({
    id: SEED_RAISE_SPACE_ID,
    key: "seed",
    name: "Seed raise",
    description: "Investors, firms, and every meeting of the seed round.",
    owner: "cos",
    attachedAppIds: ["app_5eed0a1b2c3d4e5f"],
    startAt: "2026-06-02T09:00:00.000Z",
  });

  const firm = b.type({
    name: "Firm",
    icon: "building",
    description: "A venture firm or fund.",
  });
  b.attribute(firm, { name: "Domain", type: "text", isUnique: true });
  b.attribute(firm, {
    name: "Tier",
    type: "select",
    options: ["Tier 1", "Tier 2", "Tier 3"],
  });

  const investor = b.type({
    name: "Investor",
    icon: "user",
    description: "A person we are raising from.",
  });
  b.attribute(investor, { name: "Email", type: "email", isUnique: true });
  b.attribute(investor, {
    name: "Stage",
    type: "status",
    options: SEED_RAISE_STAGES,
  });
  b.attribute(investor, {
    name: "Check size",
    type: "currency",
    currencyCode: "USD",
  });
  b.attribute(investor, { name: "Notes", type: "text" }, ACTOR_HUMAN);
  b.attribute(investor, {
    name: "Firm",
    type: "relationship",
    relationship: {
      targetTypeId: firm,
      cardinality: "many_to_one",
      inverseName: "Investors",
    },
  });

  const meeting = b.type({
    name: "Meeting",
    icon: "calendar",
    description: "A call or meeting with an investor.",
  });
  b.renamePrimary(meeting, "Title");
  b.attribute(meeting, { name: "Date", type: "date" });
  b.attribute(meeting, { name: "Notes", type: "text" });
  b.attribute(meeting, {
    name: "Investor",
    type: "relationship",
    relationship: {
      targetTypeId: investor,
      cardinality: "many_to_one",
      inverseName: "Meetings",
    },
  });

  const firmIds = FIRMS.map(([name, domain, tier]) =>
    b.record(firm, { name, domain, tier: tier === "" ? null : tier }),
  );

  const investorIds = INVESTORS.map(([name, firmIndex], index) => {
    const stage = SEED_RAISE_STAGES[index % SEED_RAISE_STAGES.length];
    const domain =
      firmIndex === null ? surnameDomain(name) : FIRMS[firmIndex][1];
    const hasCheck = stage !== "Intro" && stage !== "Passed";
    const id = b.record(
      investor,
      {
        name,
        email: `${handle(name)}@${domain}`,
        stage,
        check_size: hasCheck ? pick(random, CHECK_SIZES) : null,
        notes: random() < 0.4 ? pick(random, MEETING_NOTES) : null,
      },
      random() < 0.3 ? ACTOR_HUMAN : "cos",
    );
    if (firmIndex !== null) b.link(id, "firm", firmIds[firmIndex]);
    return id;
  });

  for (let index = 0; index < MEETING_COUNT; index += 1) {
    const investorIndex = Math.floor(random() * INVESTORS.length);
    const day = String(1 + Math.floor(random() * 28)).padStart(2, "0");
    const month = String(6 + (index % 4)).padStart(2, "0");
    const isLinked = index < MEETING_COUNT - UNLINKED_MEETINGS;
    const kind = pick(random, MEETING_KINDS);
    const id = b.record(
      meeting,
      {
        name: isLinked
          ? `${kind} with ${INVESTORS[investorIndex][0]}`
          : `${kind} (investor to be confirmed)`,
        date: `2026-${month}-${day}`,
        notes: random() < 0.6 ? pick(random, MEETING_NOTES) : null,
      },
      random() < 0.3 ? ACTOR_HUMAN : "cos",
    );
    // The last few stay unlinked so the Investor cell shows its empty state.
    if (isLinked) {
      b.link(id, "investor", investorIds[investorIndex]);
    }
  }

  return b.done();
}
