import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SpaceAccess } from "../../../api/dataspaces";
import { PRIVATE_ACCESS } from "../../../api/dataspacesAccess";
import { AccessBadge } from "./AccessBadge";

import "../../../styles/data.css";

const meta: Meta<typeof AccessBadge> = {
  title: "Data / Index / AccessBadge",
  component: AccessBadge,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Who can use a data space. Private is muted text, Shared a neutral outline, Global the accent. The title lists every grant with its level, which matters once the label collapses to a count.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof AccessBadge>;

const STATES: readonly SpaceAccess[] = [
  PRIVATE_ACCESS,
  { scope: "shared", grants: [{ bot: "ops", level: "read" }] },
  {
    scope: "shared",
    grants: [
      { bot: "ops", level: "read" },
      { bot: "recruiter", level: "write" },
    ],
  },
  {
    scope: "shared",
    grants: [
      { bot: "designer", level: "read" },
      { bot: "ops", level: "read" },
      { bot: "recruiter", level: "write" },
    ],
  },
  { scope: "global", grants: [] },
];

const rowStyle = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-4)",
} as const;

export const Private: Story = { args: { access: STATES[0] } };
export const Global: Story = { args: { access: STATES[4] } };

export const AllStates: Story = {
  render: () => (
    <div style={rowStyle}>
      {STATES.map((access) => (
        <AccessBadge
          key={`${access.scope}-${access.grants.length}`}
          access={access}
        />
      ))}
    </div>
  ),
};
