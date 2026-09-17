import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useEditLifecycle } from "./useEditLifecycle";

function setup(initialDraft = "hello") {
  const onCommit = vi.fn();
  const view = renderHook(
    (props: { initialDraft: string }) =>
      useEditLifecycle({ initialDraft: props.initialDraft, onCommit }),
    { initialProps: { initialDraft } },
  );
  return { onCommit, ...view };
}

describe("useEditLifecycle", () => {
  it("starts idle with the initial draft", () => {
    const { result } = setup();
    expect(result.current.isEditing).toBe(false);
    expect(result.current.draft).toBe("hello");
  });

  it("commits a changed draft once and leaves edit mode", () => {
    const { result, onCommit } = setup();
    act(() => result.current.start());
    expect(result.current.isEditing).toBe(true);
    act(() => result.current.setDraft("world"));
    act(() => result.current.commit());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("world");
    expect(result.current.isEditing).toBe(false);
  });

  it("is a no-op when the draft is unchanged", () => {
    const { result, onCommit } = setup();
    act(() => result.current.start());
    act(() => result.current.commit());
    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.isEditing).toBe(false);
  });

  it("treats a whitespace-only difference as unchanged", () => {
    const { result, onCommit } = setup();
    act(() => result.current.start());
    act(() => result.current.setDraft("hello  "));
    act(() => result.current.commit());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("guards against a double commit (Enter, then the unmount blur)", () => {
    const { result, onCommit } = setup();
    act(() => result.current.start());
    act(() => result.current.setDraft("world"));
    act(() => {
      result.current.commit();
      result.current.commit();
    });
    act(() => result.current.commit());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("commits a draft set in the same tick", () => {
    const { result, onCommit } = setup();
    act(() => result.current.start());
    act(() => {
      result.current.setDraft("picked");
      result.current.commit();
    });
    expect(onCommit).toHaveBeenCalledWith("picked");
  });

  it("cancel restores the initial draft and never commits", () => {
    const { result, onCommit } = setup();
    act(() => result.current.start());
    act(() => result.current.setDraft("scratch"));
    act(() => result.current.cancel());
    expect(result.current.isEditing).toBe(false);
    expect(result.current.draft).toBe("hello");
    act(() => result.current.commit());
    expect(onCommit).not.toHaveBeenCalled();

    act(() => result.current.start());
    expect(result.current.draft).toBe("hello");
  });

  it("can clear: an empty draft is a change", () => {
    const { result, onCommit } = setup();
    act(() => result.current.start());
    act(() => result.current.setDraft(""));
    act(() => result.current.commit());
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("a new session starts from the latest stored value", () => {
    const { result, rerender, onCommit } = setup();
    rerender({ initialDraft: "updated" });
    expect(result.current.draft).toBe("updated");
    act(() => result.current.start());
    expect(result.current.draft).toBe("updated");
    act(() => result.current.commit());
    expect(onCommit).not.toHaveBeenCalled();
  });
});
