import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrbLookOverlay } from "./OrbLookOverlay";

describe("the look over the orb", () => {
  it("renders one layer per part, and nothing for no look", () => {
    const { container, rerender } = render(
      <OrbLookOverlay
        look={{ hair: "curls", eyes: "wink", accessory: "headphones" }}
        bodyColor="#64d2ff"
        size={48}
      />,
    );
    const layers = [...container.querySelectorAll("[data-layer]")].map((e) =>
      e.getAttribute("data-layer"),
    );
    expect(layers).toEqual(["accessory:headphones", "hair:curls", "eyes:wink"]);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    rerender(<OrbLookOverlay look={null} bodyColor="#64d2ff" size={48} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
