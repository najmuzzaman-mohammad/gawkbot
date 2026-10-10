import type { Meta, StoryObj } from "@storybook/react-vite";

import { NotchSection } from "./NotchSection";

import "../../../styles/settings.css";

const meta: Meta<typeof NotchSection> = {
  title: "Settings / Notch",
  component: NotchSection,
  args: { save: async () => {} },
};

export default meta;

type Story = StoryObj<typeof NotchSection>;

export const JumpingOut: Story = { args: { cfg: {} } };

export const StayingInside: Story = {
  args: { cfg: { notch_jump_out: false } },
};
