import type { Meta, StoryObj } from "@storybook/react-vite";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { CreateObjectTypeDialog } from "./CreateObjectTypeDialog";
import { DataStory } from "./storyHarness";

const meta: Meta<typeof CreateObjectTypeDialog> = {
  title: "Data / Index / CreateObjectTypeDialog",
  component: CreateObjectTypeDialog,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "New object type. The plural follows the name until the operator edits it, the slug preview shows what the store will mint, and a store error such as a duplicate name (try `Investor`) renders inline.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof CreateObjectTypeDialog>;

export const Open: Story = {
  render: () => (
    <DataStory initialPath={`/data/${SEED_RAISE_SPACE_ID}`}>
      <CreateObjectTypeDialog
        spaceId={SEED_RAISE_SPACE_ID}
        takenSlugs={["investor", "firm", "meeting"]}
        open={true}
        onClose={() => undefined}
      />
    </DataStory>
  ),
};
