import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  CLIENT_DELIVERY_SPACE_ID,
  RECRUITING_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { DataSpacePage } from "./DataSpacePage";
import { DataStory } from "./storyHarness";

const meta: Meta<typeof DataSpacePage> = {
  title: "Data / Index / DataSpacePage",
  component: DataSpacePage,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "`/data/$spaceId`. Object types of one space in a list table, then a read-only summary of the relationships between them, written with the four named cardinality modes.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof DataSpacePage>;

/** Private. The Share action opens the sharing dialog. */
export const SeedRaise: Story = {
  render: () => (
    <DataStory initialPath={`/data/${SEED_RAISE_SPACE_ID}`}>
      <DataSpacePage spaceId={SEED_RAISE_SPACE_ID} />
    </DataStory>
  ),
};

/** Shared with one bot. */
export const ClientDelivery: Story = {
  render: () => (
    <DataStory initialPath={`/data/${CLIENT_DELIVERY_SPACE_ID}`}>
      <DataSpacePage spaceId={CLIENT_DELIVERY_SPACE_ID} />
    </DataStory>
  ),
};

/** Shared with two bots. */
export const Recruiting: Story = {
  render: () => (
    <DataStory initialPath={`/data/${RECRUITING_SPACE_ID}`}>
      <DataSpacePage spaceId={RECRUITING_SPACE_ID} />
    </DataStory>
  ),
};

export const GlobalCompanyDirectory: Story = {
  render: () => (
    <DataStory initialPath="/data/space_company_directory">
      <DataSpacePage spaceId="space_company_directory" />
    </DataStory>
  ),
};

export const UnknownSpace: Story = {
  render: () => (
    <DataStory initialPath="/data/space_missing">
      <DataSpacePage spaceId="space_missing" />
    </DataStory>
  ),
};
