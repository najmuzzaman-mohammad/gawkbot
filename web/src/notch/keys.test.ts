import { describe, expect, it } from "vitest";

import { BUSY_OFFICE } from "./fixtures";
import { keyAction } from "./keys";

const [approval, typed] = BUSY_OFFICE.attention;
const k = (key: string, extra = {}) =>
  keyAction({ key, typing: false, ...extra }, approval);

describe("keyAction", () => {
  it("J and K move between cards; the up and down arrows move through the replies", () => {
    expect(k("j")).toEqual({ type: "move", delta: 1 });
    expect(k("K")).toEqual({ type: "move", delta: -1 });
    expect(k("ArrowDown")).toEqual({ type: "choice", delta: 1 });
    expect(k("ArrowUp")).toEqual({ type: "choice", delta: -1 });
  });

  it("D marks a finished turn done, and nothing else", () => {
    const turn = {
      id: "finished:eng@1",
      kind: "finished",
      from: "eng",
      question: "Done.",
    };
    expect(keyAction({ key: "d", typing: false }, turn)).toEqual({
      type: "done",
    });
    expect(k("d")).toEqual({ type: "none" });
  });

  it("answers with a number or the recommended one on Enter", () => {
    expect(k("1")).toEqual({ type: "choose", optionId: "approve" });
    expect(k("2")).toEqual({ type: "choose", optionId: "reject" });
    expect(k("3")).toEqual({ type: "none" });
    expect(k("Enter")).toEqual({ type: "choose", optionId: "approve" });
  });

  it("falls back to a typed reply when a question needs words", () => {
    expect(keyAction({ key: "Enter", typing: false }, typed)).toEqual({
      type: "reply",
    });
    expect(keyAction({ key: "1", typing: false }, typed)).toEqual({
      type: "none",
    });
  });

  it("numbers the choices in the order shown, the recommended one first", () => {
    const recLast = {
      ...approval,
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
      recommended_id: "reject",
    };
    const on = (key: string) => keyAction({ key, typing: false }, recLast);
    expect(on("1")).toEqual({ type: "choose", optionId: "reject" });
    expect(on("2")).toEqual({ type: "choose", optionId: "approve" });
    expect(on("Enter")).toEqual({ type: "choose", optionId: "reject" });
  });

  it("sends a suggested reply when a question asked in words has them", () => {
    const suggested = {
      ...typed,
      suggestions: [
        { label: "HubSpot", reply: "Use HubSpot, we already pay for it." },
        { label: "Ask me later", reply: "Leave it until Monday." },
      ],
    };
    const on = (key: string) => keyAction({ key, typing: false }, suggested);
    expect(on("Enter")).toEqual({
      type: "suggest",
      text: "Use HubSpot, we already pay for it.",
    });
    expect(on("2")).toEqual({
      type: "suggest",
      text: "Leave it until Monday.",
    });
    expect(on("3")).toEqual({ type: "none" });
  });

  it("holds V to talk", () => {
    expect(k("v")).toEqual({ type: "voice_start" });
    expect(k("v", { repeat: true })).toEqual({ type: "none" });
    expect(keyAction({ key: "v", typing: false }, approval, "up")).toEqual({
      type: "voice_stop",
    });
  });

  it("stays out of the way while typing and with modifiers", () => {
    expect(keyAction({ key: "j", typing: true }, approval)).toEqual({
      type: "none",
    });
    expect(k("1", { meta: true })).toEqual({ type: "none" });
    expect(keyAction({ key: "Escape", typing: true }, approval)).toEqual({
      type: "close",
    });
  });

  it("R replies to the selected asker, or messages the Chief of Staff with nothing selected", () => {
    expect(k("r")).toEqual({ type: "reply" });
    expect(keyAction({ key: "r", typing: false }, undefined)).toEqual({
      type: "message_lead",
    });
    expect(k("m")).toEqual({ type: "message_lead" });
  });

  it("uses ⌥V for push-to-talk inside the reply box, where V is a letter", () => {
    expect(keyAction({ key: "v", typing: true }, approval)).toEqual({
      type: "none",
    });
    expect(
      keyAction({ key: "√", code: "KeyV", typing: true, alt: true }, approval),
    ).toEqual({ type: "voice_start" });
    expect(
      keyAction(
        { key: "√", code: "KeyV", typing: true, alt: true, repeat: true },
        approval,
      ),
    ).toEqual({ type: "none" });
    expect(keyAction({ key: "Alt", typing: true }, approval, "up")).toEqual({
      type: "voice_stop",
    });
  });

  it("Esc is one action whether or not you are typing", () => {
    expect(keyAction({ key: "Escape", typing: true }, approval)).toEqual({
      type: "close",
    });
    expect(keyAction({ key: "Escape", typing: false }, approval)).toEqual({
      type: "close",
    });
  });

  it("O opens the full app", () => {
    expect(k("o")).toEqual({ type: "open_full" });
    expect(keyAction({ key: "o", typing: true }, approval)).toEqual({
      type: "none",
    });
  });

  it("steps along a question's buttons with the left and right arrows", () => {
    const key = (k: string, onButton = false) =>
      keyAction({ key: k, typing: false, onButton }, undefined);
    expect(key("ArrowRight")).toEqual({ type: "option", delta: 1 });
    expect(key("ArrowLeft")).toEqual({ type: "option", delta: -1 });
    // While typing a reply the arrows move the caret, not the focus.
    expect(keyAction({ key: "ArrowRight", typing: true }, undefined)).toEqual({
      type: "none",
    });
    // Enter on the button in focus is that button's own press.
    expect(key("Enter", true)).toEqual({ type: "none" });
  });
});
