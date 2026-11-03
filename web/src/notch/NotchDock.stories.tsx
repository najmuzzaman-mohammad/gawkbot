import type { Meta, StoryObj } from "@storybook/react-vite";

import "./notch.css";
import type { DockCard } from "./dock";
import { NotchDockCards } from "./NotchDock";

const OPS: DockCard = {
  kind: "working",
  agent: {
    slug: "ops",
    name: "Ops",
    mood: "working",
    runtime: { harness: "claude-code", harness_name: "Claude Code" },
  },
  line: "I'll check PR #4091 for the design context, then compare how agent products present sparse knowledge and build the three-state mock.",
  history: ["Found 12 products worth comparing."],
};
const ASKING: DockCard = {
  kind: "needs_you",
  agent: { slug: "scout", name: "Rita Scout", mood: "needs_you" },
  line: "Start work on Find prospective customers for nex.ai? Approve and I begin; decline and nothing happens.",
  history: [],
};
const DONE: DockCard = {
  kind: "done",
  agent: { slug: "release-checker", name: "Release Checker", mood: "idle" },
  line: "I've reviewed 12 products. #4097 is safe to deploy.",
  history: ["Reading the changes waiting on the deploy"],
};

const noop = () => {};

const meta: Meta<typeof NotchDockCards> = {
  title: "Notch / Dock",
  component: NotchDockCards,
  args: {
    cards: [OPS, ASKING, DONE],
    done: new Map(),
    stopping: new Set<string>(),
    onChat: noop,
    onStop: noop,
    onClose: noop,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background:
            "linear-gradient(135deg, #6b8cff 0%, #c86dd7 60%, #ffb86b 100%)",
          padding: 24,
          display: "inline-block",
        }}
      >
        <div className="ndock-root">
          <Story />
        </div>
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotchDockCards>;

/** Working, waiting on you, and just done: the cards at the top right. */
export const ThreeKinds: Story = {};

/** One stop asked for, not yet taken: the button rests until the bot leaves. */
export const Stopping: Story = {
  args: { cards: [OPS], stopping: new Set(["ops"]) },
};
