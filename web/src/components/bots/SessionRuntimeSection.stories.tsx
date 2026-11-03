import type { Meta, StoryObj } from "@storybook/react-vite";

import { SessionRuntimeSection } from "./SessionRuntimeSection";

const meta: Meta<typeof SessionRuntimeSection> = {
  title: "Bots / SessionRuntimeSection",
  component: SessionRuntimeSection,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof SessionRuntimeSection>;

export const ClaudeCode: Story = {
  args: {
    agent: {
      runtime: {
        harness: "claude-code",
        harness_name: "Claude Code",
        model: "claude-opus-5-5",
        model_label: "Opus 5.5",
        family: "claude",
        source: "observed",
      },
      session: {
        tool: "claude-code",
        project: "shop",
        cwd: "/Users/me/shop",
        state: "working",
        live: true,
      },
    },
  },
};

// A session that has not taken a turn yet: its log names no model.
export const NoModelYet: Story = {
  args: {
    agent: {
      runtime: { harness: "codex", harness_name: "Codex CLI" },
      session: {
        tool: "codex",
        project: "api",
        cwd: "/Users/me/api",
        live: true,
      },
    },
  },
};

// A folder deep enough to overflow the row: it truncates, with the full
// path on hover.
export const LongFolder: Story = {
  args: {
    agent: {
      runtime: {
        harness: "claude-code",
        harness_name: "Claude Code",
        model: "claude-sonnet-5-5",
        model_label: "Sonnet 5.5",
      },
      session: {
        tool: "claude-code",
        project: "checkout-service",
        cwd: "/Users/me/Documents/work/clients/acme/platform/services/checkout-service",
        live: false,
      },
    },
  },
};
