import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SpaceSchema } from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { DataStory, pickType, WithSchema } from "../index/storyHarness";
import { AttributeRowMenu } from "./AttributeRowMenu";

const meta: Meta<typeof AttributeRowMenu> = {
  title: "Data / Settings / AttributeRowMenu",
  component: AttributeRowMenu,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Edit, Copy id, Delete. On the primary attribute Delete is disabled and the reason is written under it, not hidden in a tooltip.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof AttributeRowMenu>;

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
    <AttributeRowMenu
      attribute={attribute}
      onEdit={() => undefined}
      onCopyId={() => undefined}
      onDelete={() => undefined}
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

export const RegularAttribute: Story = storyFor("email");
export const PrimaryAttribute: Story = storyFor("name");
