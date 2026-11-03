import type { NotchAttention } from "./types";

// What a card offers to send back, in the order it shows them: the
// recommended one first. A question's own one-tap options when the asker
// wrote some; otherwise the replies the office suggested for the card
// (broker_notch_suggest.go), whose first is the recommendation.

export type Choice =
  | {
      kind: "option";
      key: string;
      label: string;
      detail?: string;
      recommended: boolean;
      optionId: string;
    }
  | {
      kind: "reply";
      key: string;
      label: string;
      detail: string;
      recommended: boolean;
      text: string;
    };

export function choicesOf(item: NotchAttention | undefined): Choice[] {
  if (!item) return [];
  const options = (item.options ?? []).filter((o) => !o.requires_text);
  if (options.length > 0) {
    const rec = item.recommended_id;
    const ordered = rec
      ? [
          ...options.filter((o) => o.id === rec),
          ...options.filter((o) => o.id !== rec),
        ]
      : options;
    return ordered.map((o) => ({
      kind: "option",
      key: `o:${o.id}`,
      label: o.label,
      detail: o.description,
      recommended: o.id === rec,
      optionId: o.id,
    }));
  }
  return (item.suggestions ?? []).map((s, i) => ({
    kind: "reply",
    key: `s:${i}`,
    label: s.label,
    detail: s.reply,
    recommended: i === 0,
    text: s.reply,
  }));
}
