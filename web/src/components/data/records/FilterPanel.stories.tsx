import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { FilterClause } from "../../../api/dataspaces";
import { encodeFilters } from "../../../lib/dataTableSearch";
import { FilterPanel } from "./FilterPanel";
import { DataStoryShell, type SeedContext, SeedData } from "./storyKit";

interface DemoProps {
  seed: SeedContext;
  initial?: readonly FilterClause[];
}

function Demo({ seed, initial = [] }: DemoProps) {
  const [filters, setFilters] = useState(initial);
  return (
    <div style={{ display: "grid", gap: "var(--space-3)", maxWidth: "34rem" }}>
      <div className="dr-popover dr-popover--wide">
        <FilterPanel type={seed.type} filters={filters} onChange={setFilters} />
      </div>
      <p className="data-mono">filter={encodeFilters(filters) || "(none)"}</p>
    </div>
  );
}

const meta: Meta<typeof FilterPanel> = {
  title: "Data / Records / FilterPanel",
  component: FilterPanel,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Rows of attribute, operator, value. The value input follows the attribute: option names for select and status, Yes or No for toggles, a date input for dates, and nothing at all for `is empty`. Only complete rows reach the URL; the mono line shows what would be written.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof FilterPanel>;

export const Empty: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>{(seed) => <Demo seed={seed} />}</SeedData>
    </DataStoryShell>
  ),
};

export const SeveralRows: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>
        {(seed) => (
          <Demo
            seed={seed}
            initial={[
              { attribute: "stage", operator: "equals", value: "Diligence" },
              { attribute: "check_size", operator: "greater", value: "100000" },
              { attribute: "firm", operator: "is_empty" },
            ]}
          />
        )}
      </SeedData>
    </DataStoryShell>
  ),
};
