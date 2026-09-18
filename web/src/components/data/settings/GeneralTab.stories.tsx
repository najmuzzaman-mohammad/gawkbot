import type { Meta, StoryObj } from "@storybook/react-vite";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { DataStory, pickType, WithSchema } from "../index/storyHarness";
import { GeneralTab } from "./GeneralTab";

const meta: Meta<typeof GeneralTab> = {
  title: "Data / Settings / GeneralTab",
  component: GeneralTab,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Name, plural, icon, and description with a save button that stays disabled until something changed; the slug and id in mono with copy buttons; and the danger zone. Delete goes through the two-phase impact preview. Delete-all-records is not offered in v1 (it needs a server operation).",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof GeneralTab>;

export const Investor: Story = {
  render: () => (
    <DataStory>
      <WithSchema spaceId={SEED_RAISE_SPACE_ID}>
        {(schema) => (
          <GeneralTab
            spaceId={SEED_RAISE_SPACE_ID}
            objectType={pickType(schema, "Investor")}
          />
        )}
      </WithSchema>
    </DataStory>
  ),
};
