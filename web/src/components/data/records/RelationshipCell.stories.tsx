import type { Meta, StoryObj } from "@storybook/react-vite";

import { RelationshipCell } from "./RelationshipCell";
import { recordName } from "./recordModel";
import { DataStoryShell, SeedData } from "./storyKit";

const meta: Meta<typeof RelationshipCell> = {
  title: "Data / Records / RelationshipCell",
  component: RelationshipCell,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Chips that link to the target records, an unlink button on each, and a plus that opens the record picker. `Firm` is to-one, so picking replaces. On the Firm table, `Investors` is the to-one side of the OTHER end: picking an investor who already has a firm explains the conflict and offers Move it here.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof RelationshipCell>;

interface CellStoryProps {
  typeSlug: string;
  attributeSlug: string;
  recordIndex: number;
  isEditable?: boolean;
}

function CellStory({
  typeSlug,
  attributeSlug,
  recordIndex,
  isEditable,
}: CellStoryProps) {
  return (
    <DataStoryShell>
      <SeedData typeSlug={typeSlug}>
        {({ schema, type, records }) => {
          const attribute = type.attributes.find(
            (item) => item.slug === attributeSlug,
          );
          const record = records[recordIndex];
          if (!(attribute && record)) return <p>Fixture changed.</p>;
          return (
            <div className="dr-region" style={{ maxWidth: "24rem" }}>
              <RelationshipCell
                spaceId={schema.space.id}
                record={record}
                recordName={recordName(record, type)}
                attribute={attribute}
                isEditable={isEditable}
                targetType={schema.objectTypes.find(
                  (item) => item.id === attribute.relationship?.targetTypeId,
                )}
              />
            </div>
          );
        }}
      </SeedData>
    </DataStoryShell>
  );
}

export const ToOneLinked: Story = {
  render: () => (
    <CellStory typeSlug="investor" attributeSlug="firm" recordIndex={0} />
  ),
};

export const ToOneEmpty: Story = {
  render: () => (
    <CellStory typeSlug="investor" attributeSlug="firm" recordIndex={18} />
  ),
};

export const ToManyWithConflicts: Story = {
  render: () => (
    <CellStory typeSlug="firm" attributeSlug="investors" recordIndex={0} />
  ),
};

export const ReadOnly: Story = {
  render: () => (
    <CellStory
      typeSlug="investor"
      attributeSlug="firm"
      recordIndex={0}
      isEditable={false}
    />
  ),
};
