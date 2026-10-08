import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThemeSwitcher } from "./ThemeSwitcher";

const meta: Meta<typeof ThemeSwitcher> = {
  title: "Design System/Organisms/ThemeSwitcher",
  component: ThemeSwitcher,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof ThemeSwitcher>;

export const Default: Story = {};

/** The default theme for new installs. */
export const SoftLight: Story = {
  globals: { theme: "nex-soft-light" },
};

export const SoftDark: Story = {
  globals: { theme: "nex-soft-dark" },
};

export const GlassDark: Story = {
  globals: { theme: "nex-glass-dark" },
};

export const GlassLight: Story = {
  globals: { theme: "nex-glass-light" },
};
