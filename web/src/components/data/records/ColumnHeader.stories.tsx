import type { Meta, StoryObj } from "@storybook/react-vite";

import { ColumnHeader } from "./ColumnHeader";

const noop = () => undefined;

const meta: Meta<typeof ColumnHeader> = {
  title: "Data / Records / ColumnHeader",
  component: ColumnHeader,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div
        style={{
          width: "14rem",
          padding: "var(--space-2)",
          background: "var(--bg-subtle)",
          border: "var(--border-width-sm) solid var(--border)",
          color: "var(--text-secondary)",
          fontSize: "var(--text-sm)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ColumnHeader>;

export const AttributeColumn: Story = {
  args: {
    label: "Stage",
    attributeType: "status",
    onSort: noop,
    onMove: noop,
    canMoveLeft: true,
    canMoveRight: true,
    onHide: noop,
  },
};

export const SortedDescending: Story = {
  args: { ...AttributeColumn.args, sortedDirection: "desc" },
};

export const RelationshipColumnHasNoSort: Story = {
  args: {
    label: "Firm",
    attributeType: "relationship",
    onMove: noop,
    canMoveLeft: false,
    canMoveRight: true,
    onHide: noop,
  },
};

export const PinnedNameColumn: Story = {
  args: { label: "Name", attributeType: "text", onSort: noop },
};

export const LongName: Story = {
  args: {
    ...AttributeColumn.args,
    label: "Expected close date according to the partner",
    attributeType: "date",
  },
};
