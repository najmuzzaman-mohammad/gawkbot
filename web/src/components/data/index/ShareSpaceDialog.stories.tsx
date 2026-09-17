import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DataSpace, SpaceAccess } from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { PRIVATE_ACCESS } from "../../../api/dataspacesAccess";
import { ShareSpaceDialogView } from "./ShareSpaceDialog";
import { DataStory } from "./storyHarness";

const meta: Meta<typeof ShareSpaceDialogView> = {
  title: "Data / Index / ShareSpaceDialog",
  component: ShareSpaceDialogView,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Sharing for one data space: Private, Shared with picked bots at read or write, or Global. Save stays disabled until the draft differs from the stored access. Shared with nobody stores as private and says so; going global shows one confirmation line above Save. Stories pass the roster in; the app reads the office roster.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof ShareSpaceDialogView>;

const ROSTER = ["cos", "ops", "recruiter", "designer", "human"];
const LARGE_ROSTER = [
  ...ROSTER,
  "analyst",
  "bookkeeper",
  "copywriter",
  "legal",
  "pm",
  "qa",
  "researcher",
  "support",
];

function space(access: SpaceAccess, id = SEED_RAISE_SPACE_ID): DataSpace {
  return {
    id,
    name: "Seed raise",
    description: "Investors, firms, and meetings for the seed round.",
    owner: "cos",
    objectTypeCount: 3,
    recordCount: 96,
    attachedAppIds: [],
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-16T17:30:00.000Z",
    access,
  };
}

const TWO_BOTS: SpaceAccess = {
  scope: "shared",
  grants: [
    { bot: "ops", level: "read" },
    { bot: "recruiter", level: "write" },
  ],
};

function storyFor(target: DataSpace, roster: readonly string[]): Story {
  return {
    render: () => (
      <DataStory>
        <ShareSpaceDialogView
          space={target}
          roster={roster}
          onClose={() => undefined}
        />
      </DataStory>
    ),
  };
}

export const Private: Story = storyFor(space(PRIVATE_ACCESS), ROSTER);
export const SharedWithTwoBots: Story = storyFor(space(TWO_BOTS), ROSTER);
export const Global: Story = storyFor(
  space({ scope: "global", grants: [] }),
  ROSTER,
);
/** More than eight bots: the filter input appears. */
export const LargeRosterWithFilter: Story = storyFor(
  space(TWO_BOTS),
  LARGE_ROSTER,
);
/** `intern` holds a grant but left the office; the row still renders. */
export const OrphanGrant: Story = storyFor(
  space({
    scope: "shared",
    grants: [
      { bot: "intern", level: "write" },
      { bot: "ops", level: "read" },
    ],
  }),
  ROSTER,
);
/** The space id is unknown to the store: pick Global, Save, read the error. */
export const ServerError: Story = storyFor(
  space(PRIVATE_ACCESS, "space_missing"),
  ROSTER,
);
