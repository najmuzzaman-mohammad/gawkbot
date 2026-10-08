import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PixelAvatar from "./PixelAvatar";

// The wrapper renders whatever the shared avatar renders: the smooth SVG
// mark in blob mode (the shipped default), a <canvas> in sprite mode. The
// assertions target the shared `.pixel-avatar` class so they hold for both;
// components/ui/PixelAvatar.test.tsx covers each mode's element directly.
describe("<PixelAvatar> (wiki wrapper)", () => {
  it("renders the shared bot avatar", () => {
    // Arrange / Act
    const { container } = render(<PixelAvatar slug="pm" size={22} />);

    // Assert
    expect(container.querySelector(".pixel-avatar")).not.toBeNull();
  });

  it("applies a default wiki className when none is provided", () => {
    const { container } = render(<PixelAvatar slug="cos" size={14} />);
    const avatar = container.querySelector(".pixel-avatar");
    expect(avatar).toHaveClass("wk-avatar");
  });

  it("passes a custom className through to the avatar", () => {
    const { container } = render(
      <PixelAvatar slug="cro" size={16} className="wk-avatar-custom" />,
    );
    const avatar = container.querySelector(".pixel-avatar");
    expect(avatar).toHaveClass("wk-avatar-custom");
  });

  it("wraps in a titled span when title prop is provided", () => {
    const { container } = render(
      <PixelAvatar slug="pm" size={14} title="PM avatar" />,
    );
    const wrap = container.querySelector("span.wk-avatar-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap?.getAttribute("title")).toBe("PM avatar");
    expect(wrap?.querySelector(".pixel-avatar")).not.toBeNull();
  });

  it("defaults size to 14 when omitted and still renders", () => {
    const { container } = render(<PixelAvatar slug="designer" />);
    const avatar = container.querySelector(".pixel-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("style")).toContain("width: 14px");
  });
});
