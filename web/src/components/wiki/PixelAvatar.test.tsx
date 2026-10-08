import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberAvatar } from "../../api/memberTypes";
import PixelAvatar from "./PixelAvatar";

// Wiki surfaces only carry an author slug, so the wrapper reads the chosen
// look from the office roster. Stub that read: these tests are about the
// wrapper, not the roster query.
const roster = vi.hoisted(() => ({
  avatars: new Map<string, MemberAvatar>(),
}));

vi.mock("../../hooks/useMembers", () => ({
  useMemberAvatar: (slug: string) => roster.avatars.get(slug),
}));

beforeEach(() => {
  roster.avatars.clear();
});

/** The mid tone of the body gradient: the colour the bot was given. */
function bodyFill(container: HTMLElement): string | null {
  const stops = container.querySelectorAll(".pixel-avatar linearGradient stop");
  return stops[1]?.getAttribute("stop-color") ?? null;
}

// The wrapper renders whatever the shared avatar renders. The assertions
// target the shared `.pixel-avatar` class; components/ui/PixelAvatar.test.tsx
// covers the element itself.
describe("<PixelAvatar> (wiki wrapper)", () => {
  it("renders the shared bot avatar", () => {
    // Arrange / Act
    const { container } = render(<PixelAvatar slug="pm" size={22} />);

    // Assert
    expect(container.querySelector(".pixel-avatar")).not.toBeNull();
  });

  it("draws the look the bot chose, read from the roster by slug", () => {
    // Arrange
    const { container: automatic } = render(<PixelAvatar slug="pm" />);
    const derived = bodyFill(automatic);
    roster.avatars.set("pm", { shape: "dome", color: "#123456" });

    // Act
    const { container } = render(<PixelAvatar slug="pm" />);

    // Assert
    expect(derived).not.toBeNull();
    expect(derived).not.toBe("#123456");
    expect(bodyFill(container)).toBe("#123456");
  });

  it("prefers an avatar the caller passes over the roster's", () => {
    roster.avatars.set("pm", { color: "#123456" });
    const { container } = render(
      <PixelAvatar slug="pm" avatar={{ color: "#abcdef" }} />,
    );
    expect(bodyFill(container)).toBe("#abcdef");
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
