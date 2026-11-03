import type { Meta, StoryObj } from "@storybook/react-vite";

import "./notch.css";
import { NotchVoiceLine } from "./NotchVoiceLine";

const meta: Meta<typeof NotchVoiceLine> = {
  title: "Notch / VoiceLine",
  component: NotchVoiceLine,
  args: { phase: "listening", heard: null, said: null, error: null },
  decorators: [
    (Story) => (
      <div style={{ background: "#0a0a0c", padding: 24, width: 560 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotchVoiceLine>;

/** The talk key is down. */
export const Listening: Story = {};

/** The office is answering, with what it heard above. */
export const Speaking: Story = {
  args: {
    phase: "speaking",
    heard: "who needs me?",
    said: "Ops does: it wants a go or no go on the deploy.",
  },
};

/** It could not start. */
export const Failed: Story = {
  args: { phase: "idle", error: "Voice could not connect (401)" },
};
