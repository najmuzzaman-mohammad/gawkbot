import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { OfficeMember } from "../../api/client";
import { EmptyHero } from "./EmptyHero";

const MEMBERS: OfficeMember[] = [
  { slug: "cos", name: "Chief of Staff", role: "Lead agent", built_in: true },
  { slug: "builder", name: "Builder", role: "Engineering" },
];

function buildClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(["office-members"], { members: MEMBERS });
  return client;
}

/**
 * The hero only shows in a theme that sets `--empty-hero-display` — today the
 * two Soft flavours. Under any other theme these stories render nothing, which
 * is the point: the other themes' empty states are unchanged.
 */
const meta: Meta<typeof EmptyHero> = {
  title: "Layout / EmptyHero",
  component: EmptyHero,
  globals: { theme: "nex-soft-light" },
  decorators: [
    (Story) => (
      <QueryClientProvider client={buildClient()}>
        <div style={{ width: 360, padding: 24, background: "var(--bg)" }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof EmptyHero>;

/** An empty DM: the bot's face and an invitation. */
export const EmptyDM: Story = {
  args: { slug: "cos", line: "Say hi to Chief of Staff." },
};

/** A bot with nothing assigned. */
export const NoTasks: Story = {
  args: { slug: "builder", line: "Nothing on my plate yet." },
};

/** Face only, for a surface whose own copy is already one short line. */
export const AvatarOnly: Story = {
  args: { slug: "builder" },
};

export const SoftDark: Story = {
  args: { slug: "cos", line: "Say hi to Chief of Staff." },
  globals: { theme: "nex-soft-dark" },
};

/** Any non-Soft theme: renders nothing visible. */
export const HiddenInGlass: Story = {
  args: { slug: "cos", line: "Say hi to Chief of Staff." },
  globals: { theme: "nex-glass-dark" },
};
