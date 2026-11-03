import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { IconPicker } from "./IconPicker";

import "../../../styles/data.css";

const meta: Meta<typeof IconPicker> = {
  title: "Data / Index / IconPicker",
  component: IconPicker,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Object type icon choice. Native radio inputs, so it is one tab stop and arrow keys move the selection.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof IconPicker>;

interface ControlledProps {
  disabled?: boolean;
}

function Controlled({ disabled = false }: ControlledProps) {
  const [value, setValue] = useState("building");
  return <IconPicker value={value} onChange={setValue} disabled={disabled} />;
}

export const Default: Story = { render: () => <Controlled /> };

export const Disabled: Story = { render: () => <Controlled disabled={true} /> };
