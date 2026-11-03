import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./notch.css";
import { NotchHint } from "./NotchHint";

const client = new QueryClient();
const noop = () => {};

const meta: Meta<typeof NotchHint> = {
  title: "Notch / Hint",
  component: NotchHint,
  args: {
    hint: {
      platform: "gmail",
      name: "Gmail",
      line: "Connect Gmail so your bots can read this inbox",
      since: "2026-10-15T09:00:00Z",
    },
    onOpen: noop,
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <div style={{ background: "#0a0a0c", padding: 24, width: 560 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotchHint>;

/** Gmail in front, not connected: the line with its brand mark. */
export const Gmail: Story = {};

/** A platform with no brand mark of its own: the catalog logo, or nothing. */
export const Jira: Story = {
  args: {
    hint: {
      platform: "jira",
      name: "Jira",
      line: "Connect Jira so your bots can work these issues",
      since: "2026-10-15T09:00:00Z",
    },
  },
};
