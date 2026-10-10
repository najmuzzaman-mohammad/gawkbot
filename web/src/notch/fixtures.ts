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
  earWidth: 0,
  chinHeight: 22,
};
export const NO_NOTCH = {
  notchWidth: 0,
  notchHeight: 24,
  earWidth: 64,
  chinHeight: 0,
};
