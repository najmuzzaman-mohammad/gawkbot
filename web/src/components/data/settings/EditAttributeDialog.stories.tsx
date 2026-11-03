import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SpaceSchema } from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { DataStory, pickType, WithSchema } from "../index/storyHarness";
import { EditAttributeDialog } from "./EditAttributeDialog";

const meta: Meta<typeof EditAttributeDialog> = {
  title: "Data / Settings / EditAttributeDialog",
  component: EditAttributeDialog,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Edit an attribute: name, description, required, and for select or status the option list (add, rename; ids stay stable). Type, unique, and multiple are read-only because they cannot change after creation.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof EditAttributeDialog>;

interface ForAttributeProps {
  schema: SpaceSchema;
  slug: string;
}

function ForAttribute({ schema, slug }: ForAttributeProps) {
  const investor = pickType(schema, "Investor");
  const attribute =
    investor.attributes.find((item) => item.slug === slug) ??
    investor.attributes[0];
  return (
    <EditAttributeDialog
      spaceId={SEED_RAISE_SPACE_ID}
      typeId={investor.id}
      attribute={attribute}
      onClose={() => undefined}
    />
  );
}

function storyFor(slug: string): Story {
  return {
    render: () => (
      <DataStory>
        <WithSchema spaceId={SEED_RAISE_SPACE_ID}>
          {(schema) => <ForAttribute schema={schema} slug={slug} />}
        </WithSchema>
      </DataStory>
    ),
  };
}

export const StatusWithOptions: Story = storyFor("stage");
export const PlainText: Story = storyFor("notes");
export const PrimaryName: Story = storyFor("name");
export const Relationship: Story = storyFor("firm");
