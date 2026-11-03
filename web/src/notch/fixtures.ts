import type { NotchState } from "./types";

// Shared by the notch stories and tests.
export const BUSY_OFFICE: NotchState = {
  lead: "cos",
  lead_name: "Chief of Staff",
  lead_dm: "cos__human",
  mood: "needs_you",
  headline: "2 things need you",
  agents: [
    {
      slug: "cos",
      name: "Chief of Staff",
      mood: "needs_you",
      detail: "waiting on you",
      origin: "built_in",
      runs_on: "this_machine",
      is_lead: true,
      runtime: {
        harness: "claude-code",
        harness_name: "Claude Code",
        model: "claude-opus-5-5",
        model_label: "Opus 5.5",
        family: "claude",
        source: "observed",
      },
    },
    {
      slug: "gemini",
      name: "Gemini CLI",
      mood: "needs_you",
      detail: "waiting on you",
      origin: "adopted",
      runs_on: "this_machine",
      runs_on_detail: "Gemini CLI on this machine",
      runtime: { harness: "cli-agent", harness_name: "Gemini CLI" },
    },
    {
      slug: "codex",
      name: "Codex CLI",
      mood: "error",
      detail: "auth failed",
      origin: "adopted",
      runs_on: "this_machine",
      runtime: {
        harness: "codex",
        harness_name: "Codex CLI",
        model: "gpt-6-astra",
        model_label: "GPT-6 Astra",
        family: "gpt",
        source: "default",
      },
    },
    {
      slug: "designer",
      name: "Designer",
      mood: "working",
      detail: "drafting response",
      origin: "user",
      runs_on: "this_machine",
      runtime: {
        harness: "claude-code",
        harness_name: "Claude Code",
        model: "claude-sonnet-5-5",
        model_label: "Sonnet 5.5",
        family: "claude",
        source: "binding",
      },
    },
    {
      slug: "scout",
      name: "Scout",
      mood: "done",
      detail: "just finished",
      origin: "chief_of_staff",
      runs_on: "this_machine",
    },
    {
      slug: "hermes",
      name: "Hermes",
      mood: "idle",
      origin: "imported",
      runs_on: "elsewhere",
      runs_on_detail: "Hermes gateway",
    },
  ],
  attention: [
    {
      id: "req-1",
      kind: "approval",
      from: "gemini",
      from_name: "Gemini CLI",
      channel: "cos__human",
      title: "Send the launch email?",
      question: "It goes to 1,204 people.",
      context:
        "The migration drops the old sessions table. A dry run on staging kept 0 rows; the rollback script is tested. I cannot tell whether anything outside this repo still reads that table.",
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
      recommended_id: "approve",
      blocking: true,
    },
    {
      id: "req-2",
      kind: "interview",
      from: "cos",
      channel: "cos__human",
      question: "Which CRM should the pipeline use?",
      options: [{ id: "other", label: "Other", requires_text: true }],
    },
  ],
};

/** The busy office with a finished turn waiting, its replies suggested. */
export const FINISHED_OFFICE: NotchState = {
  ...BUSY_OFFICE,
  finished: [
    {
      id: "finished:codex@2026-10-12T09:00:00Z",
      kind: "finished",
      from: "codex",
      from_name: "Codex CLI",
      title: "Your turn",
      question: "Fixed the login redirect. Want me to merge it?",
      created_at: "2026-10-12T09:00:00Z",
      recap: {
        project: "billing",
        asked: "Fix the login redirect loop",
        reply:
          "Fixed the login redirect: the session cookie was set on the wrong path. Tests pass locally. Want me to merge it, or add a regression test first?",
      },
      suggestions: [
        {
          label: "Add a test, then merge",
          reply:
            "Add a regression test for the redirect loop, then merge and watch CI.",
        },
        { label: "Merge it", reply: "Merge it and watch CI." },
        {
          label: "Hold for review",
          reply: "Hold off, I want to review it first.",
        },
      ],
    },
  ],
};

export const QUIET_OFFICE: NotchState = {
  lead: "cos",
  lead_name: "Chief of Staff",
  lead_dm: "cos__human",
  mood: "idle",
  headline: "All quiet. Nothing needs you.",
  agents: [
    {
      slug: "cos",
      name: "Chief of Staff",
      mood: "idle",
      origin: "built_in",
      runs_on: "this_machine",
      is_lead: true,
    },
    {
      slug: "designer",
      name: "Designer",
      mood: "idle",
      origin: "user",
      runs_on: "this_machine",
    },
  ],
  attention: [],
};

export const MACBOOK_NOTCH = {
  notchWidth: 186,
  notchHeight: 32,
  earWidth: 40,
  band: 0,
};
export const NO_NOTCH = {
  notchWidth: 0,
  notchHeight: 24,
  earWidth: 64,
  band: 0,
};

/** A bot set to run on this Mac, waiting to be allowed its first action. */
export const CONSENT_OFFICE: NotchState = {
  ...QUIET_OFFICE,
  mood: "needs_you",
  headline: "Ops wants to use this Mac",
  attention: [
    {
      id: "consent:ops",
      kind: "computer_consent",
      from: "ops",
      from_name: "Ops",
      title: "Wants to use this Mac",
      question: "Ops wants to click and type on this Mac. Allow it this turn?",
      context:
        "It works with its own cursor, which you can watch, and never moves yours. ⌥Esc stops every agent at once.",
      options: [
        { id: "allow", label: "Allow this turn" },
        {
          id: "allow_always",
          label: "Always allow",
          description:
            "Never ask again; one switch in Settings turns it back off.",
        },
        { id: "deny", label: "No" },
      ],
      recommended_id: "allow",
      blocking: true,
      created_at: new Date().toISOString(),
    },
  ],
};

/** The busy office with ideas waiting and terminal sessions on this Mac. */
export const HOME_OFFICE: NotchState = {
  ...BUSY_OFFICE,
  agents: [
    ...BUSY_OFFICE.agents.map((a) =>
      a.slug === "scout"
        ? {
            ...a,
            mood: "idle" as const,
            unread: 2,
            last: {
              from: "scout",
              text: "Found three companies hiring a Head of RevOps.",
              at: "2026-10-12T11:40:00Z",
            },
          }
        : a,
    ),
    {
      slug: "cc-1",
      name: "Fix the login redirect",
      mood: "idle",
      kind: "session",
      tool: "claude-code",
      tool_name: "Claude Code",
      project: "billing",
      state: "your_turn",
      updated_at: "2026-10-12T11:50:00Z",
      last_said: "Tests pass. Want me to merge it?",
    },
    {
      slug: "cx-2",
      name: "Plan the agent architecture",
      mood: "working",
      kind: "session",
      tool: "codex",
      tool_name: "Codex",
      project: "agentOS",
      state: "working",
      updated_at: "2026-10-12T11:55:00Z",
    },
  ],
  ideas: {
    enabled: true,
    checked_at: "2026-10-12T09:00:00Z",
    items: [
      {
        id: "idea:aaa",
        fingerprint: "aaa",
        name: "Release Checker",
        role: "Release checker",
        integration: "github",
        integration_name: "GitHub",
        promise:
          "Before #4097 goes to production, I'll read every change waiting on the deploy and call go or no go.",
        rationale: "Two pull requests wait on it right now.",
        cadence_label: "Every weekday at 9:00, while this Mac is awake",
        first_task: "Read the changes waiting on #4097.",
        created_at: "2026-10-12T09:00:00Z",
      },
    ],
  },
};
