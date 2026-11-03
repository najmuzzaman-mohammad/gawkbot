import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./notch.css";
import { NotchIdeas } from "./NotchIdeas";

const client = new QueryClient();

const meta: Meta<typeof NotchIdeas> = {
  title: "Notch / Ideas",
  component: NotchIdeas,
  args: {
    ideas: {
      enabled: true,
      checked_at: "2026-10-15T09:00:00Z",
      items: [
        {
          id: "idea:aaa",
          fingerprint: "aaa",
          name: "Release Checker",
          role: "Reads what waits on the deploy",
          integration: "github",
          integration_name: "GitHub",
          promise:
            "Before #4097 goes to production, I will read every change waiting on the deploy and call go or no go.",
          rationale: "Two pull requests wait on it right now.",
          cadence: "0 9 * * 1-5",
          cadence_label: "Every weekday at 9:00, while this Mac is awake",
          first_task:
            "Read #4097 and #4101 and say whether they are safe to ship.",
          evidence: [
            {
              id: "github-1",
              platform: "github",
              text: "#4097 Ship the new deploy pipeline · open",
            },
            {
              id: "github-2",
              platform: "github",
              text: "#4101 Fix flaky checkout test · open",
            },
          ],
          avatar: { shape: "bear", color: "#64d2ff" },
          created_at: "2026-10-15T09:00:00Z",
        },
        {
          id: "idea:bbb",
          fingerprint: "bbb",
          name: "Invoice Watcher",
          role: "Watches invoices",
          integration: "gmail",
          integration_name: "Gmail",
          promise:
            "When an invoice lands, like the one from Acme, I will log it and say so.",
          rationale: "One is unread now.",
          first_task: "Log the Acme invoice.",
          avatar: { shape: "lemon", color: "#ff9f0a" },
          created_at: "2026-10-15T09:00:00Z",
        },
      ],
    },
    onOpen: () => {},
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <div style={{ background: "#0a0a0c", padding: 24, width: 600 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotchIdeas>;

/** Two ideas, the first in view. */
export const TwoIdeas: Story = {};
