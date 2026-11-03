import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  RECRUITING_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { DataRouteHarness } from "../records/DataRouteHarness";

const meta: Meta<typeof DataRouteHarness> = {
  title: "Data / Record / RecordPage",
  component: DataRouteHarness,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "One record on the real route tree. Two columns from 960px of container width, one below; the attribute grid is 2-up from 520px. Attributes are edited in place. The right rail shows details the store really has; the activity timeline lands with the backend change log.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof DataRouteHarness>;

/** Fixture ids are deterministic: firms are rec_seed_1 to 12, investors follow. */
export const Investor: Story = {
  args: { initialPath: `/data/${SEED_RAISE_SPACE_ID}/r/rec_seed_14` },
};

export const FirmWithManyInvestors: Story = {
  args: { initialPath: `/data/${SEED_RAISE_SPACE_ID}/r/rec_seed_1` },
};

export const RoleWithManyCandidates: Story = {
  args: { initialPath: `/data/${RECRUITING_SPACE_ID}/r/rec_recruit_1` },
};

export const NotFound: Story = {
  args: { initialPath: `/data/${SEED_RAISE_SPACE_ID}/r/rec_missing` },
};
