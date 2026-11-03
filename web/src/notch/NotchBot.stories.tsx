import type { Meta, StoryObj } from "@storybook/react-vite";

import "./notch.css";
import { NotchBot } from "./NotchBot";
import type { Mood } from "./types";

const MOODS: Mood[] = ["working", "idle", "needs_you", "error", "done"];
const SLUGS = ["cos", "gemini", "codex", "designer", "scout"];

const meta: Meta<typeof NotchBot> = {
  title: "Notch / NotchBot",
  component: NotchBot,
  args: { slug: "gemini", mood: "needs_you", size: 72 },
  argTypes: {
    mood: { control: "inline-radio", options: MOODS },
    act: {
      control: "inline-radio",
      options: [undefined, "peeking", "fidget", "talking"],
    },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: "#000",
          padding: 40,
          display: "inline-block",
          borderRadius: 24,
        }}
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotchBot>;

export const Playground: Story = {};

export const EveryMood: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 36, alignItems: "flex-end" }}>
      {MOODS.map((m, i) => (
        <div
          key={m}
          style={{
            textAlign: "center",
            color: "rgba(255,255,255,.6)",
            font: "12px -apple-system, system-ui",
          }}
        >
          <NotchBot slug={SLUGS[i]} mood={m} size={64} phase={i} />
          <div style={{ marginTop: 14 }}>{m.replace("_", " ")}</div>
        </div>
      ))}
    </div>
  ),
};

export const Acts: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 36 }}>
      <NotchBot slug="scout" mood="idle" act="peeking" size={64} bare={true} />
      <NotchBot slug="gemini" mood="needs_you" act="fidget" size={64} />
      <NotchBot
        slug="codex"
        mood="needs_you"
        act="talking"
        size={64}
        bare={true}
      />
    </div>
  ),
};
