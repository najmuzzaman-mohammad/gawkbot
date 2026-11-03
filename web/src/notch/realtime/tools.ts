import { post } from "../../api/client";
import {
  answerRequest,
  answerWithText,
  getNotchState,
  sendMessage,
  stopBot,
} from "../api";
import { dmChannel } from "../shared";
import type { NotchState } from "../types";

/**
 * The tools the voice may call (the broker lists them in the session; see
 * internal/team/broker_realtime_notch.go). Each runs against the office
 * exactly as a click in the notch would, and returns what the voice should
 * know, small and in words: it is read aloud, not displayed.
 */

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function officeSummary(state: NotchState) {
  return {
    headline: state.headline,
    lead: state.lead_name ?? state.lead ?? "",
    bots: state.agents
      .filter((a) => a.kind !== "session")
      .map((a) => ({
        slug: a.slug,
        name: a.name,
        mood: a.mood,
        detail: a.detail ?? "",
      })),
    cards: state.attention.map((c) => ({
      id: c.id,
      from: c.from_name ?? c.from,
      title: c.title ?? "",
      question: c.question,
      options: (c.options ?? []).map((o) => ({ id: o.id, label: o.label })),
      recommended: c.recommended_id ?? "",
    })),
    finished: (state.finished ?? []).map((c) => ({
      id: c.id,
      from: c.from_name ?? c.from,
      reply: (c.recap?.reply ?? "").slice(0, 300),
    })),
  };
}

/** Runs one tool call by name. Unknown names are answered, not thrown. */
export async function runOfficeTool(
  name: string,
  args: unknown,
): Promise<unknown> {
  const a = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  switch (name) {
    case "get_office_state":
      return officeSummary(await getNotchState(true));
    case "ask_agent": {
      const text = str(a.text);
      if (!text) return { error: "nothing to say" };
      const state = await getNotchState(false);
      const slug = str(a.slug) || state.lead || "";
      const agent = state.agents.find((x) => x.slug === slug);
      if (!agent) return { error: `no bot called ${slug}` };
      const channel =
        agent.is_lead && state.lead_dm
          ? state.lead_dm
          : dmChannel("human", agent.slug);
      await sendMessage(channel, text);
      return { ok: true, told: agent.name };
    }
    case "answer_card": {
      const id = str(a.request_id);
      if (!id) return { error: "which card?" };
      const choice = str(a.choice_id);
      if (choice) await answerRequest(id, choice);
      else {
        const text = str(a.text);
        if (!text) return { error: "no answer given" };
        await answerWithText(id, text);
      }
      return { ok: true };
    }
    case "stop": {
      const slug = str(a.slug);
      if (slug) {
        await stopBot(slug);
        return { ok: true, stopped: slug };
      }
      await post("/governor", { action: "stop" });
      return { ok: true, stopped: "everyone" };
    }
    default:
      return { error: `no tool called ${name}` };
  }
}
