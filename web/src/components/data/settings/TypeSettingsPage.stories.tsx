import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  RECRUITING_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { DataStory } from "../index/storyHarness";
import { TypeSettingsPage } from "./TypeSettingsPage";

const meta: Meta<typeof TypeSettingsPage> = {
  title: "Data / Settings / TypeSettingsPage",
  component: TypeSettingsPage,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "`/data/$spaceId/t/$typeSlug/settings?tab=`. The tabs are links that set the `tab` search param. General edits the display fields and holds the danger zone; Attributes is the schema table with its create, edit, and delete dialogs.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof TypeSettingsPage>;

const investorPath = `/data/${SEED_RAISE_SPACE_ID}/t/investor/settings`;

export const General: Story = {
  render: () => (
    <DataStory initialPath={investorPath}>
      <TypeSettingsPage
        spaceId={SEED_RAISE_SPACE_ID}
        typeSlug="investor"
        tab="general"
      />
    </DataStory>
  ),
};

export const Attributes: Story = {
  render: () => (
    <DataStory initialPath={investorPath}>
      <TypeSettingsPage
        spaceId={SEED_RAISE_SPACE_ID}
        typeSlug="investor"
        tab="attributes"
      />
    </DataStory>
  ),
};

export const AttributesWithRating: Story = {
  render: () => (
    <DataStory
      initialPath={`/data/${RECRUITING_SPACE_ID}/t/interview/settings`}
    >
      <TypeSettingsPage
        spaceId={RECRUITING_SPACE_ID}
        typeSlug="interview"
        tab="attributes"
      />
    </DataStory>
  ),
};

export const UnknownObjectType: Story = {
  render: () => (
    <DataStory initialPath={`/data/${SEED_RAISE_SPACE_ID}/t/nope/settings`}>
      <TypeSettingsPage
        spaceId={SEED_RAISE_SPACE_ID}
        typeSlug="nope"
        tab="general"
      />
    </DataStory>
  ),
};
