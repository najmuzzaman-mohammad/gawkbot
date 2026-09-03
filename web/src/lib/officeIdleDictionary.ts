/**
 * Office-voice idle copy dictionary for the bot rail event pill.
 *
 * Eng decision A4: lookup order is slug overrides -> role table -> generalist
 * fallback. Copy rotates ~every 12s based on idleMs so the same bot does not
 * stare at the same line forever during a long idle.
 */

const ROTATION_INTERVAL_MS = 12_000;

/**
 * Hardcoded copy for canonical built-in bots. Slug match wins over role.
 * These are the bots users meet first, so they set the voice for the rest.
 */
const SLUG_OVERRIDES: Record<string, readonly string[]> = {
  tess: [
    "drafting a thought",
    "rereading the brief",
    "tidying the brief",
    "closing out a note",
    "thinking up a plan",
  ],
  ava: [
    "reviewing the diff",
    "running the tests",
    "skimming PRs",
    "checking CI",
    "reading the changelog",
  ],
  sam: [
    "combing Linear",
    "drafting a doc",
    "writing the update nobody reads",
    "checking burn-down",
    "rereading the brief",
  ],
};

/**
 * Role-keyed copy. Roles are normalized via `normalizeRole` before lookup so
 * "Engineer", " engineer ", and "Dev" all hit the same table.
 */
const ROLE_TABLES: Record<string, readonly string[]> = {
  // `lead` is the Chief of Staff, and it is now the ONLY built-in. The
  // librarian, app-builder, planner, executor and reviewer tables were removed
  // when the founder retired those bots as defaults: "that concept should
  // now be gone with those bots as default. their defintions also shouldn't
  // exist". The remaining entries below are ordinary ROLE copy, matched on
  // whatever role a user gives a bot they created themselves, so they are
  // not built-in definitions and they stay.
  //
  // A legacy workspace that still holds one of the retired bots falls
  // through to GENERALIST_COPY, which is correct: generic copy for a bot
  // the product no longer defines, rather than a dangling special case.
  //
  // Voice: flat, specific, mildly tedious. An idle bot is BETWEEN jobs,
  // never spectating and never lazy -- founder's rule is that gawkbot is not
  // a bystander in any messaging, because the bots do the menial work and
  // the human is the one watching a dashboard. Idle copy is where that is
  // easiest to get wrong: "watching the board" and "waiting to be asked" read
  // as a bot doing nothing, which inverts the product story. Give it some
  // small boring thing it is getting on with instead.
  lead: [
    "triaging what came in",
    "reordering the queue",
    "taking it off your plate",
    "finding the next boring thing",
  ],
  engineer: [
    "running the tests",
    "reviewing the diff",
    "skimming PRs",
    "checking CI",
    "reading the changelog",
  ],
  designer: [
    "doodling in Figma",
    "tweaking spacing",
    "picking colors",
    "nudging the kerning",
    "moving pixels",
  ],
  pm: [
    "combing Linear",
    "drafting a doc",
    "in standup mentally",
    "checking burn-down",
    "rereading the brief",
  ],
  devops: [
    "rotating the logs",
    "tailing logs",
    "checking uptime",
    "reviewing alerts",
    "patching nodes",
  ],
  marketing: [
    "scrolling X",
    "drafting copy",
    "checking GA",
    "reading a competitor blog",
    "rewriting the headline",
  ],
};

/**
 * Aliases that all collapse to the same canonical role key in ROLE_TABLES.
 */
const ROLE_ALIASES: Record<string, string> = {
  engineer: "engineer",
  developer: "engineer",
  dev: "engineer",
  designer: "designer",
  pm: "pm",
  product: "pm",
  devops: "devops",
  sre: "devops",
  platform: "devops",
  marketing: "marketing",
  growth: "marketing",
  // The built-ins, keyed off what the roster actually stores.
  lead: "lead",
  "chief of staff": "lead",
  "chief-of-staff": "lead",
  ceo: "lead",
};

/**
 * Generalist fallback when slug + role both miss. Never returns empty.
 */
const GENERALIST_COPY: readonly string[] = [
  "clearing something small",
  "tidying up after the last job",
  "filing the paperwork",
  "between tasks",
  "getting on with it",
];

interface PickIdleCopyInput {
  slug: string;
  role?: string;
  idleMs: number;
}

function normalizeRole(role: string | undefined): string | undefined {
  if (typeof role !== "string") {
    return undefined;
  }
  const trimmed = role.trim().toLowerCase();
  return trimmed.length === 0 ? undefined : trimmed;
}

function rotateIndex(idleMs: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  const safeMs = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : 0;
  return Math.floor(safeMs / ROTATION_INTERVAL_MS) % length;
}

/**
 * Pick an Office-voice idle line for a bot. Pure: same input -> same output.
 *
 * Lookup order:
 *   1. SLUG_OVERRIDES[slug.toLowerCase()] — canonical bots win.
 *   2. ROLE_TABLES via ROLE_ALIASES[normalizeRole(role)] — role match.
 *   3. GENERALIST_COPY — never crashes, never returns empty.
 */
export function pickIdleCopy(input: PickIdleCopyInput): string {
  const { slug, role, idleMs } = input;

  const slugKey = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  const slugCopy = slugKey.length > 0 ? SLUG_OVERRIDES[slugKey] : undefined;
  if (slugCopy && slugCopy.length > 0) {
    return slugCopy[rotateIndex(idleMs, slugCopy.length)];
  }

  const roleKey = normalizeRole(role);
  if (roleKey !== undefined) {
    const canonicalRole = ROLE_ALIASES[roleKey];
    if (canonicalRole !== undefined) {
      const roleCopy = ROLE_TABLES[canonicalRole];
      if (roleCopy && roleCopy.length > 0) {
        return roleCopy[rotateIndex(idleMs, roleCopy.length)];
      }
    }
  }

  return GENERALIST_COPY[rotateIndex(idleMs, GENERALIST_COPY.length)];
}
