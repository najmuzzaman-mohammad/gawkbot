import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DraftOption } from "./attributeDraft";
import { OptionsEditor } from "./OptionsEditor";

import "../../../styles/data.css";

const meta: Meta<typeof OptionsEditor> = {
  title: "Data / Settings / OptionsEditor",
  component: OptionsEditor,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Option names for a new select or status attribute: add, remove, and reorder with up and down buttons, all keyboard reachable.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof OptionsEditor>;

interface ControlledProps {
  initial: readonly DraftOption[];
  hint?: string;
  disabled?: boolean;
}

function Controlled({ initial, hint, disabled }: ControlledProps) {
  const [options, setOptions] = useState(initial);
  return (
    <div style={{ width: "calc(var(--space-8) * 10)" }}>
      <OptionsEditor
        options={options}
        onChange={setOptions}
        hint={hint}
        disabled={disabled}
      />
    </div>
  );
}

const PRIORITIES: readonly DraftOption[] = [
  { key: "low", name: "Low" },
  { key: "medium", name: "Medium" },
  { key: "high", name: "High" },
];

export const SelectOptions: Story = {
  render: () => (
    <Controlled
      initial={PRIORITIES}
      hint="A select attribute needs at least one option."
    />
  ),
};

export const EmptyStatus: Story = {
  render: () => (
    <Controlled
      initial={[]}
      hint="Leave empty to use the defaults. Defaults to To do, In progress, Done."
    />
  ),
};

export const Disabled: Story = {
  render: () => <Controlled initial={PRIORITIES} disabled={true} />,
};
