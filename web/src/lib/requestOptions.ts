import type { BotRequest, InterviewOption } from "../api/client";

export function requestOptionNeedsText(
  request: BotRequest,
  option: InterviewOption,
): boolean {
  return Boolean(
    option.requires_text ||
      (request.kind === "interview" && option.id === "answer_directly"),
  );
}

export function requestOptionTextHint(
  request: BotRequest,
  option: InterviewOption,
): string {
  if (option.text_hint) return option.text_hint;
  if (request.kind === "interview" && option.id === "answer_directly") {
    return "Type your answer for the team.";
  }
  return "Type your answer...";
}
