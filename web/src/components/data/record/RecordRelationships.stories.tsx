import type { Meta, StoryObj } from "@storybook/react-vite";

import { RECRUITING_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { recordName } from "../records/recordModel";
import {
  DataStoryShell,
  type SeedContext,
  SeedData,
} from "../records/storyKit";
import { RecordRelationships } from "./RecordRelationships";

interface DemoProps {
  seed: SeedContext;
  recordIndex: number;
  isEditable?: boolean;
}

function Demo({ seed, recordIndex, isEditable }: DemoProps) {
  const record = seed.records[recordIndex];
  return (
    <RecordRelationships
      spaceId={seed.schema.space.id}
      record={record}
      recordName={recordName(record, seed.type)}
      type={seed.type}
      objectTypes={seed.schema.objectTypes}
      isEditable={isEditable}
    />
  );
}

const meta: Meta<typeof RecordRelationships> = {
  title: "Data / Record / RecordRelationships",
  component: RecordRelationships,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "One subsection per relationship attribute: name, count, the target object type, the linked records as links, and a control to link another. Lists are capped at 12 with a Show all toggle. A to-one attribute that is already set offers Change instead of Link.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof RecordRelationships>;

export const InvestorWithFirmAndMeetings: Story = {
  render: () => (
    <DataStoryShell width="48rem">
      <SeedData>{(seed) => <Demo seed={seed} recordIndex={0} />}</SeedData>
    </DataStoryShell>
  ),
};

export const NothingLinkedYet: Story = {
  render: () => (
    <DataStoryShell width="48rem">
      <SeedData>{(seed) => <Demo seed={seed} recordIndex={18} />}</SeedData>
    </DataStoryShell>
  ),
};

export const RoleWithManyCandidates: Story = {
  render: () => (
    <DataStoryShell width="48rem">
      <SeedData spaceId={RECRUITING_SPACE_ID} typeSlug="role">
        {(seed) => <Demo seed={seed} recordIndex={0} />}
      </SeedData>
    </DataStoryShell>
  ),
};

export const ReadOnly: Story = {
  render: () => (
    <DataStoryShell width="48rem">
      <SeedData>
        {(seed) => <Demo seed={seed} recordIndex={0} isEditable={false} />}
      </SeedData>
    </DataStoryShell>
  ),
};
