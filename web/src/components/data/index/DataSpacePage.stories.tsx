import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SpaceSchema } from "../../../api/dataspaces";
import {
  CLIENT_DELIVERY_SPACE_ID,
  defaultFixtureSpaces,
  RECRUITING_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { viewSchema } from "../../../api/dataspaces.mock.store";
import { DataSpacePage } from "./DataSpacePage";
import { DataStory } from "./storyHarness";

/** The seed raise schema, as a caller who may only read it sees it. */
function readOnlySchema(): SpaceSchema {
  const state = defaultFixtureSpaces().find(
    (space) => space.space.id === SEED_RAISE_SPACE_ID,
  );
  if (!state) throw new Error("seed raise fixture missing");
  const schema = viewSchema(state);
  return { ...schema, space: { ...schema.space, callerLevel: "read" } };
}

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

/**
 * A space another bot owns and shared read-only. The Share and New object
 * type actions are withheld rather than disabled, and one quiet line says
 * who to ask.
 */
export const ReadOnly: Story = {
  render: () => {
    const schema = readOnlySchema();
    return (
      <DataStory initialPath={`/data/${schema.space.id}`} schema={schema}>
        <DataSpacePage spaceId={schema.space.id} />
      </DataStory>
    );
  },
};
