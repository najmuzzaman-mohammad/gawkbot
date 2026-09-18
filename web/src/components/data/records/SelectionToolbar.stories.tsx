import type { Meta, StoryObj } from "@storybook/react-vite";

import { SelectionToolbar } from "./SelectionToolbar";

const meta: Meta<typeof SelectionToolbar> = {
  title: "Data / Records / SelectionToolbar",
  component: SelectionToolbar,
  parameters: { layout: "padded" },
  args: { onDelete: () => undefined, onClear: () => undefined },
};

export default meta;

type Story = StoryObj<typeof SelectionToolbar>;

export const OneSelected: Story = { args: { count: 1 } };

export const ManySelected: Story = { args: { count: 1204 } };

export const NothingSelectedRendersNothing: Story = { args: { count: 0 } };
