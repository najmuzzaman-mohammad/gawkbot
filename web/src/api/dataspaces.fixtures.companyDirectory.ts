/**
 * The global space: a company directory owned by the `cos` bot that every
 * bot in the office reads and writes. Every person and domain is invented.
 */

import { createSpaceBuilder } from "./dataspaces.fixtures.builder";
import { ACTOR_HUMAN, type SpaceState } from "./dataspaces.mock.store";

export const COMPANY_DIRECTORY_SPACE_ID = "space_company_directory";
export const DIRECTORY_TEAMS = [
  "Founders",
  "Engineering",
  "Operations",
  "Sales",
] as const;

const MAIL_DOMAIN = "lanternworks.example";

const TEAM_CHARTERS: readonly string[] = [
  "Set direction, raise capital, and hire the first twenty people.",
  "Ship the product and keep it fast, correct, and boring to operate.",
  "Keep finance, people, and vendors running so nobody else has to.",
  // No charter written yet, so the cell renders its empty state.
  "",
];

type PersonRow = readonly [
  name: string,
  role: string,
  team: number | null,
  startDate: string | null,
];
const PEOPLE: readonly PersonRow[] = [
  ["Samira Koskinen-Adu", "Chief executive", 0, "2025-01-06"],
  ["Rowan Espinoza-Bright", "Chief technology officer", 0, "2025-01-06"],
  ["Tamsin Okorie", "Staff engineer", 1, "2025-04-14"],
  ["Leopold Arvidsson", "Product engineer", 1, "2025-09-02"],
  ["Nandini Varghese-Holt", "Design engineer", 1, "2026-02-17"],
  ["Marcus Eberhardt-Sol", "Head of operations", 2, "2025-06-23"],
  ["Ayasha Whitcombe", "Finance and people partner", 2, null],
  ["Caspian Delgado-Frey", "Founding account executive", 3, "2026-05-04"],
  // Signed offer, starts next month: no team and no start date on file yet.
  ["Ingrid Salo-Mbatha", "", null, null],
];

function handle(name: string): string {
  return name.split(" ")[0].toLowerCase();
}

export function buildCompanyDirectorySpace(): SpaceState {
  const b = createSpaceBuilder({
    id: COMPANY_DIRECTORY_SPACE_ID,
    key: "directory",
    name: "Company directory",
    description: "Everyone at the company and the team they sit on.",
    owner: "cos",
    access: { scope: "global", grants: [] },
    startAt: "2026-04-01T10:00:00.000Z",
  });

  const team = b.type({
    name: "Team",
    icon: "group",
    description: "A group of people with one charter.",
  });
  b.attribute(team, { name: "Charter", type: "text" });

  const person = b.type({
    name: "Person",
    namePlural: "People",
    icon: "user",
    description: "Someone who works at the company.",
  });
  b.attribute(person, { name: "Email", type: "email", isUnique: true });
  b.attribute(person, { name: "Role", type: "text" });
  b.attribute(person, {
    // Named Department because the slug `team` belongs to the relationship.
    name: "Department",
    type: "select",
    options: DIRECTORY_TEAMS,
  });
  b.attribute(person, { name: "Start date", type: "date" }, ACTOR_HUMAN);
  b.attribute(person, {
    name: "Team",
    type: "relationship",
    relationship: {
      targetTypeId: team,
      cardinality: "many_to_one",
      inverseName: "People",
    },
  });

  const teamIds = DIRECTORY_TEAMS.map((name, index) =>
    b.record(
      team,
      { name, charter: TEAM_CHARTERS[index] || null },
      index === 0 ? ACTOR_HUMAN : "cos",
    ),
  );

  for (const [index, row] of PEOPLE.entries()) {
    const [name, role, teamIndex, startDate] = row;
    const id = b.record(
      person,
      {
        name,
        email: `${handle(name)}@${MAIL_DOMAIN}`,
        role: role || null,
        department: teamIndex === null ? null : DIRECTORY_TEAMS[teamIndex],
        start_date: startDate,
      },
      index % 3 === 0 ? ACTOR_HUMAN : "cos",
    );
    if (teamIndex !== null) b.link(id, "team", teamIds[teamIndex]);
  }

  return b.done();
}
