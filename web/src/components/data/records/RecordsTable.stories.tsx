import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RowSelectionState } from "@tanstack/react-table";

import { RecordsTable, type TableSort } from "./RecordsTable";
import { DataStoryShell, type SeedContext, SeedData } from "./storyKit";
import { useColumnPrefs } from "./useColumnPrefs";
import { attributeColumnSlugs } from "./useRecordsTable";
import { useValueCommit } from "./useValueCommit";

interface DemoProps {
  seed: SeedContext;
  rows?: number;
}

function Demo({ seed, rows = 8 }: DemoProps) {
  const { schema, type, records } = seed;
  const spaceId = schema.space.id;
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [sort, setSort] = useState<TableSort | null>(null);
  const columnPrefs = useColumnPrefs(
    `story-${spaceId}`,
    type.id,
    attributeColumnSlugs(type),
  );
  const { pending, commit } = useValueCommit(spaceId);
  return (
    <div style={{ display: "flex", height: "28rem" }} className="dr-region">
      <RecordsTable
        spaceId={spaceId}
        type={type}
        objectTypes={schema.objectTypes}
        records={records.slice(0, rows)}
        sort={sort}
        onSort={(attribute, direction) => setSort({ attribute, direction })}
        columnPrefs={columnPrefs}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        pendingValue={pending}
        onCommitValue={commit}
        onPreview={() => undefined}
        onDelete={() => undefined}
      />
    </div>
  );
}

const meta: Meta<typeof RecordsTable> = {
  title: "Data / Records / RecordsTable",
  component: RecordsTable,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          'A real `<table role="grid">` in its own scroll container. Select and name stick to the start and row actions to the end, on opaque surfaces. Narrow the story to see the table scroll inside its region while the page does not. Sort here is display state only; the page drives it from the URL.',
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof RecordsTable>;

export const Default: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>{(seed) => <Demo seed={seed} />}</SeedData>
    </DataStoryShell>
  ),
};

export const NarrowContainer: Story = {
  render: () => (
    <DataStoryShell width="30rem">
      <SeedData>{(seed) => <Demo seed={seed} />}</SeedData>
    </DataStoryShell>
  ),
};

export const LastRowsNearTheEdge: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>{(seed) => <Demo seed={seed} rows={22} />}</SeedData>
    </DataStoryShell>
  ),
};
