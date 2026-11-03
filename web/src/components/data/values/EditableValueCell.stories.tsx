import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type {
  AttributeDefinition,
  AttributeValue,
} from "../../../api/dataspaces";
import { EditableValueCell } from "./EditableValueCell";
import {
  COLOR_OPTIONS,
  EDITABLE_FIXTURE_KEYS,
  FIXTURE_ATTRIBUTES,
  FIXTURE_VALUES,
  LONG_TEXT,
  makeAttribute,
} from "./storyFixtures";
import { StoryGrid, StoryRow } from "./storyLayout";

const meta: Meta<typeof EditableValueCell> = {
  title: "Data / Values / EditableValueCell",
  component: EditableValueCell,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "A focusable cell. Double-click, Enter, or F2 swaps the display for the type's editor; Enter commits, Escape cancels, and focus returns to the cell. Toggles flip in place on click or Space. Withhold `onCommit` and the cell is read-only. `isPending` shows a spinner, sets `aria-busy`, and blocks a second edit.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof EditableValueCell>;

interface CellHarnessProps {
  attribute: AttributeDefinition;
  initialValue: AttributeValue | undefined;
  isPending?: boolean;
  isReadOnly?: boolean;
}

/** Holds the value the way a records table would after a successful write. */
function CellHarness({
  attribute,
  initialValue,
  isPending,
  isReadOnly,
}: CellHarnessProps) {
  const [value, setValue] = useState(initialValue);
  return (
    <div role="grid" aria-label={attribute.name} tabIndex={-1}>
      <div role="row" tabIndex={-1}>
        <EditableValueCell
          attribute={attribute}
          value={value}
          isPending={isPending}
          onCommit={
            isReadOnly ? undefined : (next) => setValue(next ?? undefined)
          }
        />
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <div style={{ width: "calc(var(--space-8) * 7)" }}>
      <CellHarness
        attribute={FIXTURE_ATTRIBUTES.text}
        initialValue={FIXTURE_VALUES.text}
      />
    </div>
  ),
};

export const EveryTypeEditable: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <CellHarness
            attribute={FIXTURE_ATTRIBUTES[key]}
            initialValue={FIXTURE_VALUES[key]}
          />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const EveryTypeReadOnly: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <CellHarness
            attribute={FIXTURE_ATTRIBUTES[key]}
            initialValue={FIXTURE_VALUES[key]}
            isReadOnly={true}
          />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const EveryTypeEmpty: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <CellHarness
            attribute={FIXTURE_ATTRIBUTES[key]}
            initialValue={undefined}
          />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const Pending: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <CellHarness
            attribute={FIXTURE_ATTRIBUTES[key]}
            initialValue={FIXTURE_VALUES[key]}
            isPending={true}
          />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const LongTextAndMultivalue: Story = {
  render: () => (
    <StoryGrid>
      <StoryRow label="Notes">
        <CellHarness
          attribute={FIXTURE_ATTRIBUTES.text}
          initialValue={LONG_TEXT}
        />
      </StoryRow>
      <StoryRow label="Tags">
        <CellHarness
          attribute={FIXTURE_ATTRIBUTES.multiSelect}
          initialValue={FIXTURE_VALUES.multiSelect}
        />
      </StoryRow>
      <StoryRow label="All colors">
        <CellHarness
          attribute={makeAttribute("status", {
            name: "All colors",
            isMultivalue: true,
            options: COLOR_OPTIONS,
          })}
          initialValue={COLOR_OPTIONS.map((option) => option.id)}
        />
      </StoryRow>
    </StoryGrid>
  ),
};

export const RelationshipIsNeverInlineEditable: Story = {
  render: () => (
    <div style={{ width: "calc(var(--space-8) * 7)" }}>
      <CellHarness
        attribute={FIXTURE_ATTRIBUTES.relationship}
        initialValue={undefined}
      />
    </div>
  ),
};
