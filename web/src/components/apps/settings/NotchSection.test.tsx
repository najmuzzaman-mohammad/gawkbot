import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConfigSnapshot } from "../../../api/client";
import { NotchSection } from "./NotchSection";

const TOGGLE = "settings-notch-jump-out-toggle";

function renderSection(cfg: ConfigSnapshot) {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<NotchSection cfg={cfg} save={save} />);
  return { save, toggle: screen.getByTestId(TOGGLE) as HTMLInputElement };
}

describe("NotchSection", () => {
  it("is on when the choice was never made", () => {
    expect(renderSection({}).toggle.checked).toBe(true);
  });

  it("shows off when it was turned off", () => {
    expect(renderSection({ notch_jump_out: false }).toggle.checked).toBe(false);
  });

  it("saves only this setting when turned off", () => {
    const { save, toggle } = renderSection({ notch_jump_out: true });
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ notch_jump_out: false });
  });

  it("saves on when turned back on", () => {
    const { save, toggle } = renderSection({ notch_jump_out: false });
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith({ notch_jump_out: true });
  });
});
