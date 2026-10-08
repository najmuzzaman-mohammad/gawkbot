import type { Meta, StoryObj } from "@storybook/react-vite";

import { AVATAR_SHAPES, BLOB_COLORS } from "../../lib/blobAvatar";
import { PixelAvatar } from "./PixelAvatar";

const meta: Meta<typeof PixelAvatar> = {
  title: "Design System/Atoms/PixelAvatar",
  component: PixelAvatar,
  argTypes: {
    size: { control: { type: "range", min: 16, max: 128, step: 4 } },
  },
  args: { slug: "alex", size: 64 },
};

export default meta;
type Story = StoryObj<typeof PixelAvatar>;

export const Default: Story = {};

/**
 * The bot that is processing right now. In blob mode the eyes narrow and
 * widen smoothly (CSS on the SVG mask); under prefers-reduced-motion they
 * stay open and still.
 */
export const Working: Story = {
  args: { working: true },
};

/** Byline through panel scale, idle and working side by side. */
export const Sizes: StoryObj = {
  render: () => (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
      {[14, 24, 32, 48, 72].map((size) => (
        <div key={size} style={{ display: "flex", gap: 6 }}>
          <PixelAvatar slug="cos" size={size} />
          <PixelAvatar slug="cos" size={size} working={true} />
        </div>
      ))}
    </div>
  ),
};

export const Gallery: StoryObj = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {["alex", "lina", "ops", "scout", "sage", "echo", "atlas", "iris"].map(
        (slug) => (
          <div
            key={slug}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--text-secondary)",
            }}
          >
            <PixelAvatar slug={slug} size={48} />
            <span>{slug}</span>
          </div>
        ),
      )}
    </div>
  ),
};

/** A picked look (OfficeMember.avatar) overrides the slug's own. */
export const ChosenLook: Story = {
  args: { slug: "alex", avatar: { shape: "bean", color: "#3f9c8f" } },
};

/**
 * Every silhouette, each in its own palette colour. Each sits in a button, so
 * hovering wobbles it and pressing squashes it (styles/avatar-motion.css);
 * the 48px ones also join the page's single blink pool.
 */
export const EveryShape: StoryObj = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {AVATAR_SHAPES.map((shape, i) => (
        <button
          key={shape}
          type="button"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            padding: 10,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            color: "var(--text-secondary)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          <PixelAvatar
            slug="alex"
            size={48}
            avatar={{ shape, color: BLOB_COLORS[i] }}
          />
          <span>{shape}</span>
        </button>
      ))}
    </div>
  ),
};
