import type { Meta, StoryObj } from "@storybook/react-vite";

import { OpenUIAppRenderer } from "./OpenUIAppRenderer";

const meta = {
  title: "Apps / OpenUI App Renderer",
  component: OpenUIAppRenderer,
  args: {
    appId: "app_0000000000000001",
    title: "Weekly launch desk",
    openui: `root = App("Weekly launch desk", [
  Heading("Launch health", "2"),
  Metric("Ready items", 12, "3 need review", "success"),
  Progress("Checklist", 75),
  Card("Next actions", [
    Badge("On track", "success"),
    Text("Review the final three launch items with their owners.", true),
    Button("Create follow-up", @Set($draft, "Follow up on launch items"), "info")
  ])
])
$draft = ""`,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof OpenUIAppRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
