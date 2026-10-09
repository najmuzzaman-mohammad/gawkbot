import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AVATAR_SHAPES } from "../lib/blobAvatar";
import { blindDrop, handsToFeet, LEAD_SIZE, RING } from "./blind";
import { NotchBlind } from "./NotchBlind";
import { EXPANDED_HEIGHT } from "./NotchView";

describe("the blind", () => {
  it("unrolls just far enough for the lead to stand on the bottom of the window", () => {
    for (const body of AVATAR_SHAPES) {
      const top = 38;
      const drop = blindDrop(body, top, EXPANDED_HEIGHT);
      // Fabric, then the ring, then the lead from gloves to soles, then a
      // few pixels of air: the whole window, no more.
      expect(top + drop + RING + handsToFeet(body)).toBeCloseTo(
        EXPANDED_HEIGHT - 6,
        0,
      );
      // Room for the panel printed on it.
      expect(drop).toBeGreaterThan(480);
      expect(handsToFeet(body)).toBeLessThan(LEAD_SIZE * 1.6);
    }
  });

  it("prints the panel on the fabric while open, and nothing once rolled up", () => {
    const props = {
      width: 460,
      height: EXPANDED_HEIGHT,
      notchHeight: 32,
      leadSlug: "cos",
      cheer: 0,
    };
    const { rerender } = render(
      <NotchBlind {...props} expanded={true}>
        <p>printed</p>
      </NotchBlind>,
    );
    expect(screen.getByTestId("notch-blind").dataset.phase).toBe("open");
    expect(screen.getByText("printed")).toBeInTheDocument();
    rerender(
      <NotchBlind {...props} expanded={false}>
        <p>printed</p>
      </NotchBlind>,
    );
    expect(screen.getByTestId("notch-blind").dataset.phase).not.toBe("open");
  });
});
