import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { AttributeDefinition } from "../../../api/dataspaces";
import {
  COLOR_OPTIONS,
  EDITABLE_FIXTURE_KEYS,
  FIXTURE_ATTRIBUTES,
  FIXTURE_VALUES,
  LONG_TEXT,
  makeAttribute,
} from "./storyFixtures";
import { StoryGrid, StoryRow } from "./storyLayout";
import { ValueField } from "./ValueField";
import { valueToDraft } from "./valueFormat";

const meta: Meta<typeof ValueField> = {
  title: "Data / Values / ValueField",
  component: ValueField,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "The editor for one attribute, picked from `VALUE_FIELD_EDITORS` by type and driven by a string draft. Enter commits, Escape cancels, and focus leaving the field commits. Select and status use a combobox: type to filter, arrow keys to move, Enter to pick. Multivalue selects keep the list open; Space toggles and Enter saves. Rating is a radio group; arrow keys or 1 to 5 set it, and clicking the current rating clears it.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof ValueField>;

interface FieldHarnessProps {
  attribute: AttributeDefinition;
  initialDraft: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

const readoutStyle = {
  marginTop: "var(--space-1)",
  color: "var(--text-tertiary)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
} as const;

/** Owns the draft the way a form would, and shows what would be sent. */
function FieldHarness({
  attribute,
  initialDraft,
  disabled,
  autoFocus,
}: FieldHarnessProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [lastEvent, setLastEvent] = useState("editing");
  return (
    <div>
      <ValueField
        attribute={attribute}
        draft={draft}
        onDraftChange={setDraft}
        onCommit={() => setLastEvent("committed")}
        onCancel={() => {
          setDraft(initialDraft);
          setLastEvent("cancelled");
        }}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      <div style={readoutStyle}>
        draft={JSON.stringify(draft)} {lastEvent}
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <div style={{ width: "calc(var(--space-8) * 7)" }}>
      <FieldHarness
        attribute={FIXTURE_ATTRIBUTES.text}
        initialDraft="Warm intro from Dana"
      />
    </div>
  ),
};

export const EveryType: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <FieldHarness
            attribute={FIXTURE_ATTRIBUTES[key]}
            initialDraft={valueToDraft(
              FIXTURE_ATTRIBUTES[key],
              FIXTURE_VALUES[key],
            )}
          />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const EmptyDrafts: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <FieldHarness attribute={FIXTURE_ATTRIBUTES[key]} initialDraft="" />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const Disabled: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <FieldHarness
            attribute={FIXTURE_ATTRIBUTES[key]}
            initialDraft={valueToDraft(
              FIXTURE_ATTRIBUTES[key],
              FIXTURE_VALUES[key],
            )}
            disabled={true}
          />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const LongTextDraft: Story = {
  render: () => (
    <div style={{ width: "calc(var(--space-8) * 7)" }}>
      <FieldHarness
        attribute={FIXTURE_ATTRIBUTES.text}
        initialDraft={LONG_TEXT}
      />
    </div>
  ),
};

export const SingleSelectOpen: Story = {
  render: () => (
    <div
      style={{
        width: "calc(var(--space-8) * 7)",
        minHeight: "calc(var(--space-8) * 7)",
      }}
    >
      <FieldHarness
        attribute={FIXTURE_ATTRIBUTES.status}
        initialDraft="opt_progress"
        autoFocus={true}
      />
    </div>
  ),
};

export const RequiredSelectHasNoClearRow: Story = {
  render: () => (
    <div
      style={{
        width: "calc(var(--space-8) * 7)",
        minHeight: "calc(var(--space-8) * 7)",
      }}
    >
      <FieldHarness
        attribute={{ ...FIXTURE_ATTRIBUTES.select, isRequired: true }}
        initialDraft="opt_won"
        autoFocus={true}
      />
    </div>
  ),
};

export const MultivalueAllColorsOpen: Story = {
  render: () => (
    <div
      style={{
        width: "calc(var(--space-8) * 7)",
        minHeight: "calc(var(--space-8) * 8)",
      }}
    >
      <FieldHarness
        attribute={makeAttribute("select", {
          name: "All colors",
          isMultivalue: true,
          options: COLOR_OPTIONS,
        })}
        initialDraft="opt_blue,opt_red"
        autoFocus={true}
      />
    </div>
  ),
};

export const SelectWithNoOptions: Story = {
  render: () => (
    <div
      style={{
        width: "calc(var(--space-8) * 7)",
        minHeight: "calc(var(--space-8) * 3)",
      }}
    >
      <FieldHarness
        attribute={makeAttribute("select", { name: "Segment" })}
        initialDraft=""
        autoFocus={true}
      />
    </div>
  ),
};
