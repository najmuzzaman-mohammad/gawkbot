import type { Meta, StoryObj } from "@storybook/react-vite";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { AddColumnButton } from "./AddColumnButton";
import { DataStoryShell, SeedData } from "./storyKit";

const meta: Meta<typeof AddColumnButton> = {
  title: "Data / Records / AddColumnButton",
  component: AddColumnButton,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof AddColumnButton>;

export const WithHiddenColumns: Story = {
  render: () => (
    <DataStoryShell>
      <SeedData>
        {({ type }) => (
          <AddColumnButton
            spaceId={SEED_RAISE_SPACE_ID}
            typeSlug={type.slug}
            hiddenAttributes={type.attributes.filter((attribute) =>
              ["notes", "check_size"].includes(attribute.slug),
            )}
            onShow={() => undefined}
          />
        )}
      </SeedData>
    </DataStoryShell>
  ),
};

export const NothingHidden: Story = {
  render: () => (
    <DataStoryShell>
      <AddColumnButton
        spaceId={SEED_RAISE_SPACE_ID}
        typeSlug="investor"
        hiddenAttributes={[]}
        onShow={() => undefined}
      />
    </DataStoryShell>
  ),
};
