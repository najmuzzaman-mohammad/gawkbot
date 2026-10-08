import type { Meta, StoryObj } from "@storybook/react-vite";

import "./notch.css";
import { GawkBot } from "./GawkBot";
import type { Mood } from "./types";

const MOODS: Mood[] = ["working", "idle", "needs_you", "error", "done"];

const meta: Meta<typeof GawkBot> = {
  title: "Notch / GawkBot",
  component: GawkBot,
  args: { mood: "working", size: 64 },
  argTypes: { mood: { control: "inline-radio", options: MOODS } },
  decorators: [
    (Story) => (
      <div style={{ background: "#000", padding: 32, display: "inline-block" }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof GawkBot>;

export const Playground: Story = {};

export const AllMoods: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 32, alignItems: "flex-end" }}>
      {MOODS.map((m, i) => (
        <div
          key={m}
          style={{
            textAlign: "center",
            color: "#9ca3af",
            font: "11px monospace",
          }}
        >
          <GawkBot mood={m} size={64} phase={i} />
          <div style={{ marginTop: 12 }}>{m}</div>
        </div>
      ))}
    </div>
  ),
};
