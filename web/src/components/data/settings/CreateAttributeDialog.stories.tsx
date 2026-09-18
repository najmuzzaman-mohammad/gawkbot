import type { Meta, StoryObj } from "@storybook/react-vite";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { DataStory, pickType, WithSchema } from "../index/storyHarness";
import { CreateAttributeDialog } from "./CreateAttributeDialog";

const meta: Meta<typeof CreateAttributeDialog> = {
  title: "Data / Settings / CreateAttributeDialog",
  component: CreateAttributeDialog,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "New attribute in two steps: the type picker (twelve types, each with a one-line hint), then only the controls that type supports. Unique shows for text, email, URL, phone, and number; multiple for select, email, and URL; the options editor for select and status; a currency select for currency. Picking Relation swaps the body for the relationship form.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof CreateAttributeDialog>;

export const TypePicker: Story = {
  render: () => (
    <DataStory>
      <WithSchema spaceId={SEED_RAISE_SPACE_ID}>
        {(schema) => (
          <CreateAttributeDialog
            spaceId={SEED_RAISE_SPACE_ID}
            objectType={pickType(schema, "Firm")}
            objectTypes={schema.objectTypes}
            open={true}
            onClose={() => undefined}
          />
        )}
      </WithSchema>
    </DataStory>
  ),
};
