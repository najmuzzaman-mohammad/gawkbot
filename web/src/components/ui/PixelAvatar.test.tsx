import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AvatarMode } from "../../lib/avatarMode";
import { blobColor } from "../../lib/blobAvatar";
import { EYE_OPENNESS_MIN } from "../../lib/pixelAvatar";
import { PixelAvatar } from "./PixelAvatar";

// AVATAR_MODE is a constant in the product. The getter lets one test file
// drive BOTH branches: a switch whose other side never runs is dead code.
const mode = vi.hoisted(() => ({ current: "blob" as AvatarMode }));
vi.mock("../../lib/avatarMode", () => ({
  get AVATAR_MODE() {
    return mode.current;
  },
}));

const drawPixelAvatar = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pixelAvatar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pixelAvatar")>()),
  drawPixelAvatar,
}));

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

let raf: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setReducedMotion(false);
  raf = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  drawPixelAvatar.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  mode.current = "blob";
});

describe("<PixelAvatar> in blob mode", () => {
  it("renders the smooth vector mark, not a canvas", () => {
    const { container } = render(
      <PixelAvatar slug="cos" size={40} className="pam-avatar" />,
    );
    const svg = container.querySelector("svg");
    expect(container.querySelector("canvas")).toBeNull();
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass("pixel-avatar", "pixel-avatar--smooth");
    expect(svg).toHaveClass("pam-avatar");
    expect(svg).toHaveAttribute("width", "40");
    expect(svg).toHaveAttribute("height", "40");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("data-slug", "cos");
    // Inline, matching the canvas renderer, so wrapper CSS cannot stretch it.
    expect(svg?.style.width).toBe("40px");
    expect(svg?.style.height).toBe("40px");
  });

  it("fills the body with the bot's own colour and cuts two eyes with a mask", () => {
    const { container } = render(<PixelAvatar slug="cos" size={32} />);
    const mask = container.querySelector("mask");
    const body = container.querySelector("path");
    expect(mask).not.toBeNull();
    expect(body).toHaveAttribute("fill", blobColor("cos"));
    expect(body?.getAttribute("mask")).toBe(`url(#${mask?.id})`);
    expect(container.querySelectorAll(".pixel-avatar-eye")).toHaveLength(2);
    // Two avatars on one page must not share a mask id.
    const second = render(<PixelAvatar slug="cos" size={32} />).container;
    expect(second.querySelector("mask")?.id).not.toBe(mask?.id);
  });

  it("animates with CSS only while working, and never schedules frames", () => {
    const { container, rerender } = render(
      <PixelAvatar slug="cos" size={32} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toHaveAttribute("data-working");

    rerender(<PixelAvatar slug="cos" size={32} working={true} />);
    expect(svg).toHaveAttribute("data-working", "true");
    // The gawk depth tracks the sprite system's floor.
    expect(svg?.style.getPropertyValue("--pixel-avatar-gawk-min")).toBe(
      String((2 + 2 * EYE_OPENNESS_MIN) / 4),
    );
    expect(raf).not.toHaveBeenCalled();
    expect(drawPixelAvatar).not.toHaveBeenCalled();
  });

  it("draws eyes even at byline size, unlike the sprite", () => {
    const { container } = render(<PixelAvatar slug="cos" size={14} />);
    expect(container.querySelectorAll(".pixel-avatar-eye")).toHaveLength(2);
  });
});

describe("<PixelAvatar> in sprite mode", () => {
  beforeEach(() => {
    mode.current = "sprite";
  });

  it("paints the pixel portrait onto a canvas once when idle", () => {
    const { container } = render(
      <PixelAvatar slug="cos" size={40} className="pixel-avatar-panel" />,
    );
    const canvas = container.querySelector("canvas");
    expect(container.querySelector("svg")).toBeNull();
    expect(canvas).toHaveClass("pixel-avatar", "pixel-avatar-panel");
    expect(drawPixelAvatar).toHaveBeenCalledTimes(1);
    expect(drawPixelAvatar).toHaveBeenCalledWith(canvas, "cos", 40, {
      eyes: true,
      openness: 1,
    });
    expect(raf).not.toHaveBeenCalled();
  });

  it("runs the gawk loop only for a working bot with eyes", () => {
    render(<PixelAvatar slug="cos" size={40} working={true} />);
    expect(raf).toHaveBeenCalledTimes(1);

    raf.mockClear();
    render(<PixelAvatar slug="cos" size={16} working={true} />);
    // Below EYES_MIN_SIZE the sprite has no eyes, so nothing to animate.
    expect(raf).not.toHaveBeenCalled();
  });

  it("drops the motion, not the eyes, under reduced motion", () => {
    setReducedMotion(true);
    render(<PixelAvatar slug="cos" size={40} working={true} />);
    expect(raf).not.toHaveBeenCalled();
    expect(drawPixelAvatar).toHaveBeenCalledWith(expect.anything(), "cos", 40, {
      eyes: true,
      openness: 1,
    });
  });
});
