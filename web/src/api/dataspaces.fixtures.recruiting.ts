/**
 * ICP example 3: Marcus's recruiting pipeline, owned by the `recruiter` bot.
 * Every person and domain here is invented; phone numbers use the reserved
 * 555-01xx range.
 */

import {
  createRandom,
  createSpaceBuilder,
  pick,
} from "./dataspaces.fixtures.builder";
import { ACTOR_HUMAN, type SpaceState } from "./dataspaces.mock.store";

export const RECRUITING_SPACE_ID = "space_recruiting";
export const CANDIDATE_STAGES = [
  "Applied",
  "Screen",
  "Onsite",
  "Offer",
  "Hired",
  "Rejected",
] as const;

const ROLES: readonly (readonly [
  name: string,
  team: string,
  openings: number,
])[] = [
  ["Senior Backend Engineer", "Engineering", 2],
  ["Product Designer", "Design", 1],
  ["Customer Success Lead", "Success", 1],
];

const SKILLS = [
  "Go",
  "TypeScript",
  "Postgres",
  "Figma",
  "User research",
  "Onboarding",
  "SQL",
  "Public speaking",
];
const SKILLS_BY_ROLE: readonly (readonly string[])[] = [
  ["Go", "TypeScript", "Postgres", "SQL"],
  ["Figma", "User research", "TypeScript"],
  ["Onboarding", "SQL", "Public speaking", "User research"],
];

const CANDIDATES = [
  "Aurelio Banerjee-Stone",
  "Freya Lindahl",
  "Kofi Mensah-Ward",
  "Marguerite Oyelaran",
  "Stellan Rybak",
  "Indira Castellanos",
  "Thaddeus Moreau-Finch",
  "Yuki Hoshizora",
  "Ottoline Pereira",
  "Bashir Tamimi-Cole",
  "Saoirse Winterbourne",
  "Emeka Nwachukwu-Bell",
  "Liesel Hartmann-Oyo",
  "Cormac Delacroix",
  "Anouk Verbruggen",
  "Zainab Qureshi-Lund",
  "Percival Nakamura",
  "Rosalind Achebe",
  "Mateus Figueiredo-Hale",
  "Elowen Trevithick",
  "Ravindra Somasundaram",
  "Clementine Abara",
  "Lorcan Vasquez-Ito",
  "Hanneke Dijkstra-Mbeki",
];
const MAIL_DOMAINS = [
  "postbox.example",
  "inkwellmail.example",
  "harbor.example",
];
const INTERVIEWERS = [
  "Dana Whitlock-Ames",
  "Ibrahim Solheim",
  "Petra Vancea",
  "Marlowe Oduya",
];
const INTERVIEW_KINDS = [
  "Recruiter screen",
  "Hiring manager call",
  "Work sample review",
  "Onsite panel",
];
const INTERVIEW_COUNT = 30;

function handle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/ +/g, ".");
}

export function buildRecruitingSpace(): SpaceState {
  const random = createRandom(7731);
  const b = createSpaceBuilder({
    id: RECRUITING_SPACE_ID,
    key: "recruit",
    name: "Recruiting",
    description: "Open roles, candidates per role, and every interview.",
    owner: "recruiter",
    access: {
      scope: "shared",
      grants: [
        { bot: "cos", level: "write" },
        { bot: "ops", level: "read" },
      ],
    },
    startAt: "2026-07-20T08:15:00.000Z",
  });

  const role = b.type({
    name: "Role",
    icon: "briefcase",
    description: "A position we are hiring for.",
  });
  b.attribute(role, {
    name: "Team",
    type: "select",
    options: ["Engineering", "Design", "Success"],
  });
  b.attribute(role, { name: "Openings", type: "number" });

  const candidate = b.type({
    name: "Candidate",
    icon: "user",
    description: "A person in the hiring pipeline.",
  });
  b.attribute(candidate, { name: "Email", type: "email", isUnique: true });
  b.attribute(candidate, {
    name: "Stage",
    type: "status",
    options: CANDIDATE_STAGES,
  });
  b.attribute(candidate, {
    name: "Skills",
    type: "select",
    isMultivalue: true,
    options: SKILLS,
  });
  b.attribute(candidate, { name: "LinkedIn", type: "url" });
  b.attribute(candidate, { name: "Phone", type: "phone" }, ACTOR_HUMAN);
  b.attribute(candidate, {
    name: "Role",
    type: "relationship",
    relationship: {
      targetTypeId: role,
      cardinality: "many_to_one",
      inverseName: "Candidates",
    },
  });

  const interview = b.type({
    name: "Interview",
    icon: "chat",
    description: "One conversation with a candidate, with a rating.",
  });
  b.attribute(interview, { name: "Date", type: "date" });
  b.attribute(interview, { name: "Rating", type: "rating" });
  b.attribute(interview, { name: "Interviewer", type: "text" });
  b.attribute(interview, {
    name: "Candidate",
    type: "relationship",
    relationship: {
      targetTypeId: candidate,
      cardinality: "many_to_one",
      inverseName: "Interviews",
    },
  });

  const roleIds = ROLES.map(([name, team, openings]) =>
    b.record(role, { name, team, openings }, ACTOR_HUMAN),
  );

  const candidateIds = CANDIDATES.map((name, index) => {
    const roleIndex = index % ROLES.length;
    const pool = SKILLS_BY_ROLE[roleIndex];
    const skills = pool.filter(() => random() < 0.6);
    const suffix = String(10 + index).padStart(2, "0");
    const id = b.record(
      candidate,
      {
        name,
        email: `${handle(name)}@${pick(random, MAIL_DOMAINS)}`,
        stage: CANDIDATE_STAGES[index % CANDIDATE_STAGES.length],
        skills: skills.length > 0 ? skills : null,
        linkedin:
          random() < 0.7
            ? `https://www.linkedin.com/in/${handle(name).replace(/\./g, "-")}`
            : null,
        phone: random() < 0.5 ? `+1 415 555 01${suffix}` : null,
      },
      random() < 0.35 ? ACTOR_HUMAN : "recruiter",
    );
    b.link(id, "role", roleIds[roleIndex]);
    return id;
  });

  for (let index = 0; index < INTERVIEW_COUNT; index += 1) {
    const candidateIndex = Math.floor(random() * CANDIDATES.length);
    const day = String(1 + Math.floor(random() * 28)).padStart(2, "0");
    const month = String(8 + (index % 2)).padStart(2, "0");
    const id = b.record(
      interview,
      {
        name: `${pick(random, INTERVIEW_KINDS)}: ${CANDIDATES[candidateIndex]}`,
        date: `2026-${month}-${day}`,
        // Upcoming interviews have no rating yet.
        rating: random() < 0.8 ? 1 + Math.floor(random() * 5) : null,
        interviewer: random() < 0.9 ? pick(random, INTERVIEWERS) : null,
      },
      random() < 0.3 ? ACTOR_HUMAN : "recruiter",
    );
    b.link(id, "candidate", candidateIds[candidateIndex]);
  }

  return b.done();
}
