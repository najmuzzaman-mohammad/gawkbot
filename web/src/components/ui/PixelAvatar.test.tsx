import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLINK_MIN_SIZE } from "../../lib/avatarBlink";
import { blobColor, blobShapeIndex } from "../../lib/blobAvatar";
import { gawkMark } from "../../lib/gawkAvatar";
import { BlobAvatar } from "./BlobAvatar";
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

describe("<PixelAvatar>", () => {
  it("renders the character as an svg with the call-site classes", () => {
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

  it("paints the body in the bot's own tones, with two eyes", () => {
    const { container } = render(<PixelAvatar slug="cos" size={32} />);
    const mark = gawkMark("cos");
    expect(mark.color).toBe(blobColor("cos"));
    const body = container.querySelector(
      `.avatar-motion-body > path[d="${mark.body}"]`,
    );
    expect(body).not.toBeNull();
    const gradientId = body?.getAttribute("fill")?.slice(5, -1);
    const stops = container.querySelectorAll(`#${gradientId} stop`);
    expect(stops).toHaveLength(3);
    expect(stops[1]).toHaveAttribute("stop-color", mark.color);
    expect(container.querySelectorAll(".pixel-avatar-eye")).toHaveLength(2);
    // Two avatars on one page must not share gradient ids.
    const second = render(<PixelAvatar slug="cos" size={32} />).container;
    expect(second.querySelector("linearGradient")?.id).not.toBe(gradientId);
  });

  it("animates with CSS only while working, and never schedules frames", () => {
    const { container, rerender } = render(
      <PixelAvatar slug="cos" size={32} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toHaveAttribute("data-working");

    rerender(<PixelAvatar slug="cos" size={32} working={true} />);
    expect(svg).toHaveAttribute("data-working", "true");
    expect(svg?.style.getPropertyValue("--pixel-avatar-gawk-min")).not.toBe("");
    expect(raf).not.toHaveBeenCalled();
  });

  it("draws eyes even at byline size", () => {
    const { container } = render(<PixelAvatar slug="cos" size={14} />);
    expect(container.querySelectorAll(".pixel-avatar-eye")).toHaveLength(2);
  });

  it("draws the bot's chosen species and colour", () => {
    const shape = blobShapeIndex("cos") === 4 ? "loaf" : "pill";
    const avatar = { shape, color: "#13579b" } as const;
    const { container } = render(
      <PixelAvatar slug="cos" size={32} avatar={avatar} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-shape", shape);
    const mark = gawkMark("cos", { avatar });
    expect(
      container.querySelector(`.avatar-motion-body > path[d="${mark.body}"]`),
    ).not.toBeNull();
    expect(mark.body).not.toBe(gawkMark("cos").body);
    expect(container.innerHTML).toContain('stop-color="#13579b"');
  });

  it("carries the motion hooks: wobble on the svg, squash on the body", () => {
    const { container } = render(<PixelAvatar slug="cos" size={32} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("avatar-motion");
    expect(svg?.querySelector(".avatar-motion-body")).not.toBeNull();
    expect(container.querySelectorAll(".avatar-motion-eye")).toHaveLength(2);
  });

  it("joins the blink pool only when large and idle", () => {
    const enabled = () => useAvatarBlink.mock.lastCall?.[1];
    render(<PixelAvatar slug="cos" size={BLINK_MIN_SIZE} />);
    expect(enabled()).toBe(true);
    render(<PixelAvatar slug="cos" size={BLINK_MIN_SIZE - 8} />);
    expect(enabled()).toBe(false);
    // A working bot is already moving its eyes.
    render(<PixelAvatar slug="cos" size={48} working={true} />);
    expect(enabled()).toBe(false);
  });
});

describe("<BlobAvatar>", () => {
  it("is an image when named and decoration when not", () => {
    const named = render(
      <BlobAvatar slug="cos" size={40} label="Chief of Staff" />,
    ).container.querySelector("svg");
    expect(named).toHaveAttribute("role", "img");
    expect(named).toHaveAttribute("aria-label", "Chief of Staff");
    const bare = render(
      <BlobAvatar slug="cos" size={40} />,
    ).container.querySelector("svg");
    expect(bare).toHaveAttribute("aria-hidden", "true");
  });

  it("changes its face with the expression, and never blinks a happy face", () => {
    const calm = render(<BlobAvatar slug="cos" size={48} />).container
      .innerHTML;
    const happy = render(<BlobAvatar slug="cos" size={48} expression="happy" />)
      .container.innerHTML;
    expect(happy).not.toBe(calm);
    // Last call is the happy one: closed eyes have nothing to blink.
    expect(useAvatarBlink.mock.lastCall?.[1]).toBe(false);
  });

  it("clips the highlight to the body so a rotated highlight cannot leak", () => {
    const { container } = render(<BlobAvatar slug="cos" size={48} />);
    const clipped = container.querySelector("g[clip-path] ellipse[transform]");
    expect(clipped).not.toBeNull();
    expect(container.querySelector("ellipse[clip-path]")).toBeNull();
  });
});
