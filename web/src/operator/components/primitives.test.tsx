import { useState } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type TabDef, Tabs } from "./primitives";

type Id = "ui" | "data" | "knowledge";

const TABS: readonly TabDef<Id>[] = [
  { id: "ui", label: "UI" },
  { id: "data", label: "Data" },
  { id: "knowledge", label: "Knowledge" },
];

// Stateful harness: selection follows focus, as in the real consumers.
function Harness({ initial = "ui" as Id }: { initial?: Id }) {
  const [active, setActive] = useState<Id>(initial);
  return <Tabs tabs={TABS} active={active} onSelect={setActive} />;
}

describe("Tabs keyboard contract (ARIA tablist)", () => {
  it("gives the strip ONE Tab stop via roving tabindex", () => {
    const { getByRole } = render(<Harness initial="data" />);
    expect(getByRole("tab", { name: "Data" }).tabIndex).toBe(0);
    expect(getByRole("tab", { name: "UI" }).tabIndex).toBe(-1);
    expect(getByRole("tab", { name: "Knowledge" }).tabIndex).toBe(-1);
  });

  it("moves selection AND focus with ArrowRight/ArrowLeft, wrapping", () => {
    const { getByRole } = render(<Harness initial="ui" />);
    fireEvent.keyDown(getByRole("tab", { name: "UI" }), { key: "ArrowRight" });
    const data = getByRole("tab", { name: "Data" });
    expect(data.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(data);
    // ArrowLeft from the FIRST tab wraps to the last.
    fireEvent.keyDown(data, { key: "ArrowLeft" });
    fireEvent.keyDown(getByRole("tab", { name: "UI" }), { key: "ArrowLeft" });
    const knowledge = getByRole("tab", { name: "Knowledge" });
    expect(knowledge.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(knowledge);
  });

  it("jumps to the first/last tab with Home/End", () => {
    const { getByRole } = render(<Harness initial="data" />);
    fireEvent.keyDown(getByRole("tab", { name: "Data" }), { key: "End" });
    expect(
      getByRole("tab", { name: "Knowledge" }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(getByRole("tab", { name: "Knowledge" }), {
      key: "Home",
    });
    expect(getByRole("tab", { name: "UI" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(getByRole("tab", { name: "UI" }));
  });

  it("leaves other keys alone (no hijacked typing or Tab)", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <Tabs tabs={TABS} active="ui" onSelect={onSelect} />,
    );
    fireEvent.keyDown(getByRole("tab", { name: "UI" }), { key: "Tab" });
    fireEvent.keyDown(getByRole("tab", { name: "UI" }), { key: "a" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the strip reachable when the active id is stale", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      // A stale id no tab owns: the first tab takes the Tab stop.
      <Tabs tabs={TABS} active={"gone" as Id} onSelect={onSelect} />,
    );
    const first = getByRole("tab", { name: "UI" });
    expect(first.tabIndex).toBe(0);
    // Arrow keys still work, falling back to index 0 as the origin.
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("data");
  });
});
