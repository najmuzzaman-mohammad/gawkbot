import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  COLOR_OPTIONS,
  EDITABLE_FIXTURE_KEYS,
  FIXTURE_ATTRIBUTES,
  FIXTURE_VALUES,
  LONG_TEXT,
  makeAttribute,
} from "./storyFixtures";
import { StoryGrid, StoryRow } from "./storyLayout";
import { ValueCell } from "./ValueCell";

const meta: Meta<typeof ValueCell> = {
  title: "Data / Values / ValueCell",
  component: ValueCell,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Read-only display of one attribute value, picked from `VALUE_CELL_RENDERERS` by attribute type. Numbers and currency are right-aligned with tabular figures, dates never shift with the viewer's timezone, URL, email, and phone are real links, and an empty value is a muted middle dot.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof ValueCell>;

export const Default: Story = {
  args: { attribute: FIXTURE_ATTRIBUTES.text, value: FIXTURE_VALUES.text },
};

export const EveryType: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <ValueCell
            attribute={FIXTURE_ATTRIBUTES[key]}
            value={FIXTURE_VALUES[key]}
          />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const EmptyValues: Story = {
  render: () => (
    <StoryGrid>
      {EDITABLE_FIXTURE_KEYS.map((key) => (
        <StoryRow key={key} label={FIXTURE_ATTRIBUTES[key].name}>
          <ValueCell attribute={FIXTURE_ATTRIBUTES[key]} value={undefined} />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const LongText: Story = {
  render: () => (
    <StoryGrid>
      <StoryRow label="Notes">
        <ValueCell attribute={FIXTURE_ATTRIBUTES.text} value={LONG_TEXT} />
      </StoryRow>
      <StoryRow label="Website">
        <ValueCell
          attribute={FIXTURE_ATTRIBUTES.url}
          value="https://dundermifflin.example/paper/catalog/2026/autumn/premium-cardstock?ref=newsletter"
        />
      </StoryRow>
      <StoryRow label="Tags (overflow)">
        <ValueCell
          attribute={FIXTURE_ATTRIBUTES.multiSelect}
          value={FIXTURE_ATTRIBUTES.multiSelect.options.map(
            (option) => option.id,
          )}
        />
      </StoryRow>
    </StoryGrid>
  ),
};

const allColors = makeAttribute("select", {
  name: "All colors",
  isMultivalue: true,
  options: COLOR_OPTIONS,
});
const allColorsStatus = makeAttribute("status", {
  name: "All colors",
  isMultivalue: true,
  options: COLOR_OPTIONS,
});
const firstHalf = COLOR_OPTIONS.slice(0, 3).map((option) => option.id);
const secondHalf = COLOR_OPTIONS.slice(3).map((option) => option.id);

export const AllOptionColors: Story = {
  render: () => (
    <StoryGrid>
      <StoryRow label="Select">
        <ValueCell attribute={allColors} value={firstHalf} />
      </StoryRow>
      <StoryRow label="Select">
        <ValueCell attribute={allColors} value={secondHalf} />
      </StoryRow>
      <StoryRow label="Status">
        <ValueCell attribute={allColorsStatus} value={firstHalf} />
      </StoryRow>
      <StoryRow label="Status">
        <ValueCell attribute={allColorsStatus} value={secondHalf} />
      </StoryRow>
    </StoryGrid>
  ),
};

export const NumbersAndCurrency: Story = {
  render: () => (
    <StoryGrid>
      <StoryRow label="Whole">
        <ValueCell attribute={FIXTURE_ATTRIBUTES.number} value={1250} />
      </StoryRow>
      <StoryRow label="Fractional">
        <ValueCell attribute={FIXTURE_ATTRIBUTES.number} value={0.375} />
      </StoryRow>
      <StoryRow label="USD, whole">
        <ValueCell attribute={FIXTURE_ATTRIBUTES.currency} value={48000} />
      </StoryRow>
      <StoryRow label="USD, cents">
        <ValueCell attribute={FIXTURE_ATTRIBUTES.currency} value={1999.5} />
      </StoryRow>
      <StoryRow label="EUR">
        <ValueCell
          attribute={makeAttribute("currency", { currencyCode: "EUR" })}
          value={7200}
        />
      </StoryRow>
      <StoryRow label="No code (USD)">
        <ValueCell attribute={makeAttribute("currency")} value={310} />
      </StoryRow>
    </StoryGrid>
  ),
};

export const Ratings: Story = {
  render: () => (
    <StoryGrid>
      {[1, 2, 3, 4, 5].map((rating) => (
        <StoryRow key={rating} label={`${rating} out of 5`}>
          <ValueCell attribute={FIXTURE_ATTRIBUTES.rating} value={rating} />
        </StoryRow>
      ))}
    </StoryGrid>
  ),
};

export const Toggles: Story = {
  render: () => (
    <StoryGrid>
      <StoryRow label="Yes">
        <ValueCell attribute={FIXTURE_ATTRIBUTES.toggle} value={true} />
      </StoryRow>
      <StoryRow label="No">
        <ValueCell attribute={FIXTURE_ATTRIBUTES.toggle} value={false} />
      </StoryRow>
      <StoryRow label="Never set">
        <ValueCell attribute={FIXTURE_ATTRIBUTES.toggle} value={undefined} />
      </StoryRow>
    </StoryGrid>
  ),
};
