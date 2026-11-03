import type { Meta, StoryObj } from "@storybook/react-vite";

import { RecordsSkeleton } from "./RecordsSkeleton";

const meta: Meta<typeof RecordsSkeleton> = {
  title: "Data / Records / RecordsSkeleton",
  component: RecordsSkeleton,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="dr-region" style={{ height: "24rem" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof RecordsSkeleton>;

export const Default: Story = { args: { label: "Loading investors" } };
