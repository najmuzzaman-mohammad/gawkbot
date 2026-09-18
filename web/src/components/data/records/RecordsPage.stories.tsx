import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  CLIENT_DELIVERY_SPACE_ID,
  RECRUITING_SPACE_ID,
  SEED_RAISE_SPACE_ID,
} from "../../../api/dataspaces.fixtures";
import { DataRouteHarness } from "./DataRouteHarness";

const meta: Meta<typeof DataRouteHarness> = {
  title: "Data / Records / RecordsPage",
  component: DataRouteHarness,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The records table screen on the real route tree with an in-memory history, reading the mock data client. Sort, filter, search, page, page size, and the peek drawer are URL state; column order and hidden columns are localStorage.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof DataRouteHarness>;

export const Investors: Story = {
  args: { initialPath: `/data/${SEED_RAISE_SPACE_ID}/t/investor` },
};

export const SortedAndFiltered: Story = {
  args: {
    initialPath: `/data/${SEED_RAISE_SPACE_ID}/t/investor?sort=stage&dir=desc&filter=check_size.greater.50000`,
  },
};

export const SmallPages: Story = {
  args: {
    initialPath: `/data/${RECRUITING_SPACE_ID}/t/candidate?size=10&page=2`,
  },
};

export const NothingMatches: Story = {
  args: { initialPath: `/data/${SEED_RAISE_SPACE_ID}/t/investor?q=zzzz` },
};

export const PeekOpen: Story = {
  args: { initialPath: `/data/${SEED_RAISE_SPACE_ID}/t/firm?peek=rec_seed_1` },
};

export const DatesAndToggles: Story = {
  args: { initialPath: `/data/${CLIENT_DELIVERY_SPACE_ID}/t/deliverable` },
};

export const UnknownObjectType: Story = {
  args: { initialPath: `/data/${SEED_RAISE_SPACE_ID}/t/nope` },
};

export const UnknownDataSpace: Story = {
  args: { initialPath: "/data/space_missing/t/investor" },
};
