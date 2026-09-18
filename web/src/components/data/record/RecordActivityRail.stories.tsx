import type { Meta, StoryObj } from "@storybook/react-vite";

import { RECRUITING_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { DataStoryShell, SeedData } from "../records/storyKit";
import { RecordActivityRail } from "./RecordActivityRail";

const meta: Meta<typeof RecordActivityRail> = {
  title: "Data / Record / RecordActivityRail",
  component: RecordActivityRail,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The right rail. There is no activity backend in v1, so this shows details the store really has: the record id, who created it and when, the object type, the data space, and the apps attached to the space. No events are invented.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof RecordActivityRail>;

export const UsedByAnApp: Story = {
  render: () => (
    <DataStoryShell width="22rem">
      <SeedData>
        {({ schema, type, records }) => (
          <RecordActivityRail
            space={schema.space}
            type={type}
            record={records[0]}
          />
        )}
      </SeedData>
    </DataStoryShell>
  ),
};

export const NoAppsYet: Story = {
  render: () => (
    <DataStoryShell width="22rem">
      <SeedData spaceId={RECRUITING_SPACE_ID} typeSlug="candidate">
        {({ schema, type, records }) => (
          <RecordActivityRail
            space={schema.space}
            type={type}
            record={records[2]}
          />
        )}
      </SeedData>
    </DataStoryShell>
  ),
};
