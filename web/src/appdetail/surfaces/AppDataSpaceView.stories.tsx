import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  AppDataSpaceView,
  type SpaceObjectTypeSummary,
} from "./AppDataSpaceView";

// The view is pure, so every state below is just props. The three themes are
// the toolbar switch: nothing here hardcodes a colour, and the tab reuses the
// app-detail token classes (opr-*) the rest of this surface is built from.

const investors: SpaceObjectTypeSummary = {
  slug: "investor",
  name: "Investor",
  namePlural: "Investors",
  recordCount: 3,
  attributes: [
    { slug: "name", name: "Name", type: "text" },
    { slug: "stage", name: "Stage", type: "status" },
    { slug: "check_size", name: "Check size", type: "currency" },
  ],
};

const firms: SpaceObjectTypeSummary = {
  slug: "firm",
  name: "Firm",
  namePlural: "Firms",
  recordCount: 2,
  attributes: [
    { slug: "name", name: "Name", type: "text" },
    { slug: "domain", name: "Domain", type: "url" },
  ],
};

const meta = {
  title: "App detail/Data space",
  component: AppDataSpaceView,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
  args: {
    spaceId: "space_seed_raise",
    spaceName: "Seed raise",
    spaceOwner: "cos",
    objectTypes: [investors, firms],
    selectedTypeSlug: "investor",
    onSelectType: () => {},
    rows: [
      {
        id: "rec_1",
        values: {
          name: "Ada Lovelace",
          stage: "Pitched",
          check_size: "250,000",
        },
      },
      {
        id: "rec_2",
        values: { name: "Grace Hopper", stage: "Diligence", check_size: "" },
      },
    ],
    total: 3,
    recordsState: "ready" as const,
  },
} satisfies Meta<typeof AppDataSpaceView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The normal case: a space with records, one type open. */
export const Ready: Story = {};

/** A cell with no value reads "none" rather than going blank. */
export const EmptyCells: Story = {
  args: {
    rows: [{ id: "rec_1", values: { name: "Ada Lovelace" } }],
    total: 1,
  },
};

/** Records are still loading; the space header is already useful. */
export const LoadingRecords: Story = {
  args: { rows: [], total: 0, recordsState: "loading" as const },
};

/** The type exists but the read failed. Honest, and retryable by reopening. */
export const RecordsError: Story = {
  args: { rows: [], total: 0, recordsState: "error" as const },
};

/** A real and common state: the space is attached but the bot has not filled it. */
export const NoRecordsYet: Story = {
  args: { rows: [], total: 0 },
};

/** A brand-new space, before its owning bot has defined anything. */
export const NoObjectTypes: Story = {
  args: { objectTypes: [], selectedTypeSlug: "", rows: [], total: 0 },
};

/** A space whose owner is not known to this surface drops the byline cleanly. */
export const UnknownOwner: Story = {
  args: { spaceOwner: "" },
};
