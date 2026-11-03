import type { Meta, StoryObj } from "@storybook/react-vite";

import { OptionPill } from "./OptionPill";
import { COLOR_OPTIONS } from "./storyFixtures";

const meta: Meta<typeof OptionPill> = {
  title: "Data / Values / OptionPill",
  component: OptionPill,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "A select or status option. `option.color` is a semantic slot (`neutral`, `blue`, `green`, `yellow`, `red`, `purple`) that `data-values.css` resolves to a theme token pair, so pills retint across Nex Light, Nex Dark, and Noir Gold. The `status` variant adds a leading dot so state still reads without color.",
      },
    },
  },
  argTypes: {
    variant: { control: "inline-radio", options: ["select", "status"] },
  },
};

export default meta;

type Story = StoryObj<typeof OptionPill>;

const rowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2)",
} as const;

export const Default: Story = {
  args: { option: COLOR_OPTIONS[1], variant: "select" },
};

export const AllColorsSelect: Story = {
  render: () => (
    <div style={rowStyle}>
      {COLOR_OPTIONS.map((option) => (
        <OptionPill key={option.id} option={option} />
      ))}
    </div>
  ),
};

export const AllColorsStatus: Story = {
  render: () => (
    <div style={rowStyle}>
      {COLOR_OPTIONS.map((option) => (
        <OptionPill key={option.id} option={option} variant="status" />
      ))}
    </div>
  ),
};

export const LongNameTruncates: Story = {
  render: () => (
    <div style={{ width: "calc(var(--space-8) * 4)" }}>
      <OptionPill
        variant="status"
        option={{
          id: "opt_long",
          name: "Waiting on procurement and legal review",
          color: "yellow",
        }}
      />
    </div>
  ),
};
