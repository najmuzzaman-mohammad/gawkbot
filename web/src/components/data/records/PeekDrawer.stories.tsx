import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { RECRUITING_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { Button } from "../DataButton";
import { PeekDrawer } from "./PeekDrawer";
import { DataStoryShell, type SeedContext, SeedData } from "./storyKit";

interface DemoProps {
  seed: SeedContext;
  recordId: string;
}

function Demo({ seed, recordId }: DemoProps) {
  const [peek, setPeek] = useState<string | null>(recordId);
  return (
    <>
      <Button variant="outline" onClick={() => setPeek(recordId)}>
        Preview
      </Button>
      <PeekDrawer
        spaceId={seed.schema.space.id}
        recordId={peek}
        objectTypes={seed.schema.objectTypes}
        onClose={() => setPeek(null)}
      />
    </>
  );
}

const meta: Meta<typeof PeekDrawer> = {
  title: "Data / Records / PeekDrawer",
  component: PeekDrawer,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof PeekDrawer>;

export const Investor: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>
        {(seed) => <Demo seed={seed} recordId={seed.records[1].id} />}
      </SeedData>
    </DataStoryShell>
  ),
};

export const RoleWithMoreThanFiveCandidates: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData spaceId={RECRUITING_SPACE_ID} typeSlug="role">
        {(seed) => <Demo seed={seed} recordId={seed.records[0].id} />}
      </SeedData>
    </DataStoryShell>
  ),
};

export const RecordNotFound: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>
        {(seed) => <Demo seed={seed} recordId="rec_missing" />}
      </SeedData>
    </DataStoryShell>
  ),
};
