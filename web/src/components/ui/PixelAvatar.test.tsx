import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLINK_MIN_SIZE } from "../../lib/avatarBlink";
import { AVATAR_SHAPES, blobColor, blobShapeIndex } from "../../lib/blobAvatar";
import { paintFor } from "../../lib/toon/paint";
import { OrbAvatar } from "./OrbAvatar";
import { PixelAvatar } from "./PixelAvatar";

const useAvatarBlink = vi.hoisted(() => vi.fn());
vi.mock("../../lib/avatarBlink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/avatarBlink")>()),
  useAvatarBlink,
}));

let raf: ReturnType<typeof vi.fn>;

beforeEach(() => {
  raf = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", raf);
  useAvatarBlink.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The two eyes: big inked whites. */
const eyes = (root: Element) => root.querySelectorAll(".toon-eye");

describe("<PixelAvatar>", () => {
  it("renders the orb as an svg with the call-site classes", () => {
    const { container } = render(
      <PixelAvatar slug="cos" size={40} className="pam-avatar" />,
    );
    const svg = container.querySelector("svg");
    expect(container.querySelector("canvas")).toBeNull();
    expect(svg).toHaveClass("pixel-avatar", "pixel-avatar--smooth");
    expect(svg).toHaveClass("pam-avatar");
    expect(svg).toHaveAttribute("width", "40");
    expect(svg).toHaveAttribute("height", "40");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("data-slug", "cos");
    // Inline, so wrapper CSS sizes the box and not the mark.
    expect(svg?.style.width).toBe("40px");
    expect(svg?.style.height).toBe("40px");
  });

  it("paints the bot's own body in its own colour, with two eyes", () => {
    const { container } = render(<PixelAvatar slug="cos" size={32} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute(
      "data-body",
      AVATAR_SHAPES[blobShapeIndex("cos")],
    );
    // The body is painted from the bot's own colour.
    expect(container.querySelector(".toon-body")).toHaveAttribute(
      "fill",
      paintFor(blobColor("cos")).base,
    );
    expect(eyes(container)).toHaveLength(2);
    // Two avatars on one page must not share clip ids.
    const clipId = container.querySelector("clipPath")?.id;
    const second = render(<PixelAvatar slug="cos" size={32} />).container;
    expect(clipId).toBeTruthy();
    expect(second.querySelector("clipPath")?.id).not.toBe(clipId);
  });

  it("is still when idle and runs the orb's loop only while working", () => {
    const { container, rerender } = render(
      <PixelAvatar slug="cos" size={32} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-face", "calm");
    expect(svg).not.toHaveAttribute("data-live");
    expect(raf).not.toHaveBeenCalled();

    rerender(<PixelAvatar slug="cos" size={32} working={true} />);
    expect(svg).toHaveAttribute("data-face", "working");
    expect(svg).toHaveAttribute("data-live", "true");
    expect(raf).toHaveBeenCalled();
  });

  it("draws eyes even at byline size", () => {
    const { container } = render(<PixelAvatar slug="cos" size={14} />);
    expect(eyes(container)).toHaveLength(2);
  });

  it("draws the bot's chosen body and colour", () => {
    const shape = AVATAR_SHAPES[(blobShapeIndex("cos") + 3) % 8];
    const avatar = { shape, color: "#13579b" } as const;
    const { container } = render(
      <PixelAvatar slug="cos" size={32} avatar={avatar} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-body", shape);
    expect(container.querySelector(".toon-body")).toHaveAttribute(
      "fill",
      paintFor("#13579b").base,
    );
  });

  it("understands the previous character set's shape ids", () => {
    const { container } = render(
      <PixelAvatar slug="cos" size={32} avatar={{ shape: "shield" }} />,
    );
    expect(container.querySelector("svg")).toHaveAttribute(
      "data-body",
      "ghost",
    );
  });

  it("carries the motion hooks: wobble on the svg, squash on the body", () => {
    const { container } = render(<PixelAvatar slug="cos" size={32} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("avatar-motion");
    expect(svg?.querySelector(".avatar-motion-body")).not.toBeNull();
  });

  it("joins the blink pool only when large and idle", () => {
    const enabled = () => useAvatarBlink.mock.lastCall?.[1];
    render(<PixelAvatar slug="cos" size={BLINK_MIN_SIZE} />);
    expect(enabled()).toBe(true);
    render(<PixelAvatar slug="cos" size={BLINK_MIN_SIZE - 8} />);
    expect(enabled()).toBe(false);
    // A working bot is live: it blinks on its own.
    render(<PixelAvatar slug="cos" size={48} working={true} />);
    expect(enabled()).toBe(false);
  });
});

describe("<OrbAvatar>", () => {
  it("is an image when named and decoration when not", () => {
    const named = render(
      <OrbAvatar slug="cos" size={40} label="Chief of Staff" />,
    ).container.querySelector("svg");
    expect(named).toHaveAttribute("role", "img");
    expect(named).toHaveAttribute("aria-label", "Chief of Staff");
    const bare = render(
      <OrbAvatar slug="cos" size={40} />,
    ).container.querySelector("svg");
    expect(bare).toHaveAttribute("aria-hidden", "true");
  });

  it("changes its face, and never blinks a happy face", () => {
    const mouth = (face: "calm" | "happy" | "oops") =>
      render(<OrbAvatar slug="cos" size={48} face={face} />)
        .container.querySelector(".toon-mouth")
        ?.getAttribute("d");
    const calm = mouth("calm");
    const oops = mouth("oops");
    const happy = mouth("happy");
    expect(calm).toBeTruthy();
    expect(oops).not.toBe(calm);
    expect(happy).not.toBe(calm);
    // Last call is the happy one: a grin that wide has nothing to blink.
    expect(useAvatarBlink.mock.lastCall?.[1]).toBe(false);
  });

  it("blinks through the pool: the orb's own blink, on request", () => {
    render(<OrbAvatar slug="cos" size={48} />);
    const onBlink = useAvatarBlink.mock.lastCall?.[2];
    expect(typeof onBlink).toBe("function");
    onBlink();
    // The orb animates a blink over a few frames.
    expect(raf).toHaveBeenCalled();
  });
});
