import type { Meta, StoryObj } from "@storybook/react-vite";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { RelationshipChip } from "./RelationshipChip";
import { DataStoryShell } from "./storyKit";

const TARGET = {
  id: "rec_seed_1",
  typeId: "type_seed_1",
  name: "Tidewrack Capital",
};

const meta: Meta<typeof RelationshipChip> = {
  title: "Data / Records / RelationshipChip",
  component: RelationshipChip,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <DataStoryShell>
        <div className="dr-chip-list">
          <Story />
        </div>
      </DataStoryShell>
    ),
  ],
  args: { spaceId: SEED_RAISE_SPACE_ID, target: TARGET },
};

export default meta;

type Story = StoryObj<typeof RelationshipChip>;

export const ReadOnly: Story = {};

export const WithUnlink: Story = {
  args: { onUnlink: () => undefined, ownerName: "Mirela Okonjo-Hart" },
};

export const UnlinkPending: Story = {
  args: { ...WithUnlink.args, disabled: true },
};

export const LongName: Story = {
  args: {
    ...WithUnlink.args,
    target: {
      ...TARGET,
      name: "Oddfellow Yard Ventures Opportunity Fund III (Cayman) LP",
    },
  },
};
