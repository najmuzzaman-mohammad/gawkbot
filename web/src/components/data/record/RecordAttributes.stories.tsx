import type { Meta, StoryObj } from "@storybook/react-vite";

import { RECRUITING_SPACE_ID } from "../../../api/dataspaces.fixtures";
import {
  DataStoryShell,
  type SeedContext,
  SeedData,
} from "../records/storyKit";
import { useValueCommit } from "../records/useValueCommit";
import { RecordAttributes } from "./RecordAttributes";

interface DemoProps {
  seed: SeedContext;
  recordIndex: number;
  isReadOnly?: boolean;
}

/** Reads the live record back from the page query so edits show. */
function Demo({ seed, recordIndex, isReadOnly = false }: DemoProps) {
  const record = seed.records[recordIndex];
  const { pending, commit } = useValueCommit(seed.schema.space.id);
  return (
    <RecordAttributes
      record={record}
      type={seed.type}
      pendingValue={pending}
      onCommit={
        isReadOnly ? undefined : (slug, next) => commit(record, slug, next)
      }
    />
  );
}

const meta: Meta<typeof RecordAttributes> = {
  title: "Data / Record / RecordAttributes",
  component: RecordAttributes,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Filled attributes in a grid (2-up from 520px of container width), each editable in place. Empty attributes collapse into a strip of plus buttons that open that attribute's editor in the grid.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof RecordAttributes>;

export const CandidateWithEmptyAttributes: Story = {
  render: () => (
    <DataStoryShell width="48rem">
      <SeedData spaceId={RECRUITING_SPACE_ID} typeSlug="candidate">
        {(seed) => <Demo seed={seed} recordIndex={1} />}
      </SeedData>
    </DataStoryShell>
  ),
};

export const OneColumn: Story = {
  render: () => (
    <DataStoryShell width="24rem">
      <SeedData>{(seed) => <Demo seed={seed} recordIndex={1} />}</SeedData>
    </DataStoryShell>
  ),
};

export const ReadOnly: Story = {
  render: () => (
    <DataStoryShell width="48rem">
      <SeedData>
        {(seed) => <Demo seed={seed} recordIndex={0} isReadOnly={true} />}
      </SeedData>
    </DataStoryShell>
  ),
};
