import type { Meta, StoryObj } from "@storybook/react-vite";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { DataStory, pickType, WithSchema } from "../index/storyHarness";
import { AttributeProperties } from "./AttributeProperties";
import { AttributeRowMenu } from "./AttributeRowMenu";

const meta: Meta<typeof AttributeProperties> = {
  title: "Data / Settings / AttributeProperties",
  component: AttributeProperties,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The Properties cell and the row menu of the attributes table, one line per Investor attribute: flag chips, the currency code, option pills, and the relationship target with its cardinality mode.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof AttributeProperties>;

const rowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-2) 0",
  borderBottom: "var(--border-width-sm) solid var(--border-light)",
} as const;

export const EveryInvestorAttribute: Story = {
  render: () => (
    <DataStory>
      <WithSchema spaceId={SEED_RAISE_SPACE_ID}>
        {(schema) => (
          <div>
            {pickType(schema, "Investor").attributes.map((attribute) => (
              <div key={attribute.id} style={rowStyle}>
                <span>{attribute.name}</span>
                <AttributeProperties
                  attribute={attribute}
                  objectTypes={schema.objectTypes}
                />
                <AttributeRowMenu
                  attribute={attribute}
                  onEdit={() => undefined}
                  onCopyId={() => undefined}
                  onDelete={() => undefined}
                />
              </div>
            ))}
          </div>
        )}
      </WithSchema>
    </DataStory>
  ),
};
