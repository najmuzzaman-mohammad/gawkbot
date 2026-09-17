import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DataSpace } from "../../../api/dataspaces";
import { PRIVATE_ACCESS } from "../../../api/dataspacesAccess";
import { DataIndexPage } from "./DataIndexPage";
import { DataStory } from "./storyHarness";

const meta: Meta<typeof DataIndexPage> = {
  title: "Data / Index / DataIndexPage",
  component: DataIndexPage,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "`/data`. Every data space, grouped by the bot that owns it. Bots create spaces, so there is no create action; the empty state tells the operator what to say to a bot.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof DataIndexPage>;

export const FixtureSpaces: Story = {
  render: () => (
    <DataStory>
      <DataIndexPage />
    </DataStory>
  ),
};

export const NoSpacesYet: Story = {
  render: () => (
    <DataStory spaces={[]}>
      <DataIndexPage />
    </DataStory>
  ),
};

const BASE = {
  description: "",
  objectTypeCount: 2,
  recordCount: 40,
  attachedAppIds: [],
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-16T17:30:00.000Z",
} as const;

const EVERY_STATE: readonly DataSpace[] = [
  {
    ...BASE,
    id: "space_a",
    name: "Seed raise",
    description:
      "Investors, firms, and meetings for the seed round. A long description truncates inside its own cell so the row keeps one line and the full text stays in the title.",
    owner: "cos",
    attachedAppIds: ["app_5eed0a1b2c3d4e5f"],
    access: PRIVATE_ACCESS,
  },
  {
    ...BASE,
    id: "space_b",
    name: "Board prep",
    owner: "cos",
    access: { scope: "shared", grants: [{ bot: "ops", level: "read" }] },
  },
  {
    ...BASE,
    id: "space_c",
    name: "Vendor list",
    owner: "ops",
    access: {
      scope: "shared",
      grants: [
        { bot: "cos", level: "write" },
        { bot: "designer", level: "read" },
        { bot: "recruiter", level: "read" },
      ],
    },
  },
  {
    ...BASE,
    id: "space_d",
    name: "Company directory",
    owner: "recruiter",
    access: { scope: "global", grants: [] },
  },
];

/** Private, shared with one bot, shared with three, and global. */
export const EveryAccessState: Story = {
  render: () => (
    <DataStory spaces={EVERY_STATE}>
      <DataIndexPage />
    </DataStory>
  ),
};
