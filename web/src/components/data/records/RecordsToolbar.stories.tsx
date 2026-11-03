import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { FilterClause } from "../../../api/dataspaces";
import type { TableSort } from "./RecordsTable";
import { RecordsToolbar } from "./RecordsToolbar";
import { DataStoryShell, type SeedContext, SeedData } from "./storyKit";

interface DemoProps {
  seed: SeedContext;
  initialFilters?: readonly FilterClause[];
  initialSort?: TableSort | null;
  initialQuery?: string;
}

function Demo({
  seed,
  initialFilters = [],
  initialSort = null,
  initialQuery = "",
}: DemoProps) {
  const [filters, setFilters] = useState(initialFilters);
  const [sort, setSort] = useState(initialSort);
  const [query, setQuery] = useState(initialQuery);
  return (
    <RecordsToolbar
      type={seed.type}
      filters={filters}
      onFiltersChange={setFilters}
      sort={sort}
      onClearSort={() => setSort(null)}
      query={query}
      onQueryChange={setQuery}
    />
  );
}

const meta: Meta<typeof RecordsToolbar> = {
  title: "Data / Records / RecordsToolbar",
  component: RecordsToolbar,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof RecordsToolbar>;

export const Clean: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>{(seed) => <Demo seed={seed} />}</SeedData>
    </DataStoryShell>
  ),
};

export const FilteredSortedSearched: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>
        {(seed) => (
          <Demo
            seed={seed}
            initialFilters={[
              { attribute: "stage", operator: "equals", value: "Pitched" },
              { attribute: "email", operator: "is_not_empty" },
            ]}
            initialSort={{ attribute: "stage", direction: "asc" }}
            initialQuery="capital"
          />
        )}
      </SeedData>
    </DataStoryShell>
  ),
};

export const Narrow: Story = {
  render: () => (
    <DataStoryShell width="24rem">
      <SeedData>
        {(seed) => (
          <Demo
            seed={seed}
            initialSort={{ attribute: "_updated_at", direction: "desc" }}
          />
        )}
      </SeedData>
    </DataStoryShell>
  ),
};
