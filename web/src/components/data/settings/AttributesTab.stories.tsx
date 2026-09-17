import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  CLIENT_DELIVERY_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { DataStory, pickType, WithSchema } from "../index/storyHarness";
import { AttributesTab } from "./AttributesTab";

const meta: Meta<typeof AttributesTab> = {
  title: "Data / Settings / AttributesTab",
  component: AttributesTab,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Attributes of one object type. Properties are plain text chips; option pills are the only color. The row menu holds Edit, Copy id, and Delete; Delete is disabled on the primary attribute with the reason written under it.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof AttributesTab>;

export const Investor: Story = {
  render: () => (
    <DataStory>
      <WithSchema spaceId={SEED_RAISE_SPACE_ID}>
        {(schema) => (
          <AttributesTab
            spaceId={SEED_RAISE_SPACE_ID}
            objectType={pickType(schema, "Investor")}
            objectTypes={schema.objectTypes}
          />
        )}
      </WithSchema>
    </DataStory>
  ),
};

export const Deliverable: Story = {
  render: () => (
    <DataStory>
      <WithSchema spaceId={CLIENT_DELIVERY_SPACE_ID}>
        {(schema) => (
          <AttributesTab
            spaceId={CLIENT_DELIVERY_SPACE_ID}
            objectType={pickType(schema, "Deliverable")}
            objectTypes={schema.objectTypes}
          />
        )}
      </WithSchema>
    </DataStory>
  ),
};
