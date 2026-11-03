import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { RECRUITING_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { Button } from "../DataButton";
import { NewRecordDialog } from "./NewRecordDialog";
import { DataStoryShell, type SeedContext, SeedData } from "./storyKit";

interface DemoProps {
  seed: SeedContext;
}

function Demo({ seed }: DemoProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [created, setCreated] = useState<string | null>(null);
  return (
    <>
      <Button onClick={() => setIsOpen(true)}>Add {seed.type.name}</Button>
      {created ? <p className="data-mono">created {created}</p> : null}
      <NewRecordDialog
        spaceId={seed.schema.space.id}
        type={seed.type}
        open={isOpen}
        onClose={() => setIsOpen(false)}
        onCreated={(record) => {
          setCreated(record.id);
          setIsOpen(false);
        }}
      />
    </>
  );
}

const meta: Meta<typeof NewRecordDialog> = {
  title: "Data / Records / NewRecordDialog",
  component: NewRecordDialog,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Required attributes first, the rest behind a disclosure, every field the same editor the table uses. Try an email that a Candidate already has to see the inline unique error. Relationship attributes are not in the form.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof NewRecordDialog>;

export const Investor: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>{(seed) => <Demo seed={seed} />}</SeedData>
    </DataStoryShell>
  ),
};

export const CandidateWithManyOptionalAttributes: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData spaceId={RECRUITING_SPACE_ID} typeSlug="candidate">
        {(seed) => <Demo seed={seed} />}
      </SeedData>
    </DataStoryShell>
  ),
};
