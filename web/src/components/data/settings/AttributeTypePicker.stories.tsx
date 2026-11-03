import type { Meta, StoryObj } from "@storybook/react-vite";

import { AttributeTypePicker } from "./AttributeTypePicker";

import "../../../styles/data.css";

const meta: Meta<typeof AttributeTypePicker> = {
  title: "Data / Settings / AttributeTypePicker",
  component: AttributeTypePicker,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Step one of a new attribute. One bordered list, two columns, each type with its icon, label, and a one-line hint.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof AttributeTypePicker>;

export const Default: Story = {
  render: () => (
    <div style={{ width: "min(44rem, 90vw)" }}>
      <AttributeTypePicker onPick={() => undefined} />
    </div>
  ),
};
