import type { Meta, StoryObj } from "@storybook/react-vite";

import { ATTRIBUTE_TYPES } from "../../../api/dataspaces";
import {
  AttributeTypeIcon,
  OBJECT_TYPE_ICON_KEYS,
  objectTypeIcon,
} from "./attributeTypeIcon";
import { StoryGrid, StoryRow } from "./storyLayout";
import { attributeTypeLabel } from "./valueFormat";

const meta: Meta<typeof AttributeTypeIcon> = {
  title: "Data / Values / AttributeTypeIcon",
  component: AttributeTypeIcon,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Icon per attribute type, plus the `objectTypeIcon(key)` resolver for `ObjectType.icon`. Icons are decorative and always sit next to a text label. Unknown object-type keys fall back to a box.",
      },
    },
  },
  argTypes: {
    type: { control: "select", options: ATTRIBUTE_TYPES },
  },
};

export default meta;

type Story = StoryObj<typeof AttributeTypeIcon>;

export const Default: Story = {
  args: { type: "text" },
};

export const AllAttributeTypes: Story = {
  render: () => (
    <StoryGrid>
      {ATTRIBUTE_TYPES.map((type) => (
        <StoryRow key={type} label={attributeTypeLabel(type)}>
          <AttributeTypeIcon type={type} />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const ObjectTypeIcons: Story = {
  render: () => (
    <StoryGrid>
      {[...OBJECT_TYPE_ICON_KEYS, "not-a-real-key"].map((key) => {
        const Icon = objectTypeIcon(key);
        return (
          <StoryRow key={key} label={key}>
            <Icon className="dv-type-icon" aria-hidden="true" />
          </StoryRow>
        );
      })}
    </StoryGrid>
  ),
};
