import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type {
  AttributeDefinition,
  AttributeValue,
} from "../../../api/dataspaces";
import {
  EDITABLE_FIXTURE_KEYS,
  FIXTURE_ATTRIBUTES,
  FIXTURE_VALUES,
} from "../values/storyFixtures";
import { StoryGrid, StoryRow } from "../values/storyLayout";
import { InPlaceValue } from "./InPlaceValue";

interface LiveProps {
  attribute: AttributeDefinition;
  initial: AttributeValue | undefined;
}

function Live({ attribute, initial }: LiveProps) {
  const [value, setValue] = useState(initial);
  return (
    <InPlaceValue
      attribute={attribute}
      value={value}
      onCommit={(next) => setValue(next ?? undefined)}
    />
  );
}

const meta: Meta<typeof InPlaceValue> = {
  title: "Data / Record / InPlaceValue",
  component: InPlaceValue,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "A value edited where it stands on the record page. The display is a button, so click and Enter both open the editor; Escape cancels and focus returns to the value. Link values (url, email, phone) stay links and get a pencil button instead. Toggles flip on click.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof InPlaceValue>;

export const EveryType: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <Live
            attribute={FIXTURE_ATTRIBUTES[key]}
            initial={FIXTURE_VALUES[key]}
          />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const Saving: Story = {
  args: {
    attribute: FIXTURE_ATTRIBUTES.text,
    value: FIXTURE_VALUES.text,
    isPending: true,
    onCommit: () => undefined,
  },
};

export const ReadOnly: Story = {
  args: { attribute: FIXTURE_ATTRIBUTES.text, value: FIXTURE_VALUES.text },
};

export const TitleVariant: Story = {
  args: {
    attribute: FIXTURE_ATTRIBUTES.text,
    value: "Mirela Okonjo-Hart",
    variant: "title",
    onCommit: () => undefined,
  },
};
