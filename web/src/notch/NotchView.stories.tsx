import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./notch.css";

import { gang } from "./antics";
import {
  BUSY_OFFICE,
  HOME_OFFICE,
  MACBOOK_NOTCH,
  NO_NOTCH,
  QUIET_OFFICE,
} from "./fixtures";
import { NotchView } from "./NotchView";

const noop = () => {};
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const lead = {
  kind: "agent" as const,
  slug: "cos",
  name: "Chief of Staff",
  channel: "cos__human",
};

const meta: Meta<typeof NotchView> = {
  title: "Notch / NotchView",
  component: NotchView,
  args: {
    state: HOME_OFFICE,
    geometry: { ...MACBOOK_NOTCH, expandedWidth: 760, expandedHeight: 500 },
    expanded: false,
    mode: "home",
    screen: { kind: "suggestions" },
    gang: gang(BUSY_OFFICE.attention, BUSY_OFFICE.agents),
    boredom: 0,
    now: Date.parse("2026-10-12T12:00:00Z"),
    selectedId: "req-1",
    answering: new Set(),
    composer: null,
    sending: false,
    error: null,
    voiceAvailable: true,
    onPick: noop,
    onExpand: noop,
    onPeekHeight: noop,
    onBack: noop,
    onSettings: noop,
    onNewBot: noop,
    onNewBotSubmit: noop,
    onOpenFull: noop,
    onStop: noop,
    onShowSource: noop,
    onCompose: noop,
    onSelect: noop,
    onAnswer: noop,
    onReply: noop,
    onSend: noop,
    onOpen: noop,
    onComposerText: noop,
    onComposerSubmit: noop,
    onComposerCancel: noop,
    onVoice: noop,
    onKeyboard: noop,
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <div
          style={{
            position: "relative",
            height: 620,
            background: "linear-gradient(160deg, #3b3f58, #1d2030 70%)",
          }}
        >
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotchView>;

export const Collapsed: Story = {};
export const Fidgeting: Story = { args: { boredom: 1 } };
export const Quiet: Story = { args: { state: QUIET_OFFICE, gang: [] } };
/** Hovering the notch: the short list that drops out of it. */
export const HoverList: Story = { args: { expanded: true, mode: "peek" } };
/** Home on the suggestions group. */
export const HomeSuggestions: Story = { args: { expanded: true } };
/** Home on a bot with a question for you. */
export const HomeQuestion: Story = {
  args: {
    expanded: true,
    screen: {
      kind: "agent",
      slug: "gemini",
      name: "Gemini CLI",
      channel: "gemini__human",
    },
  },
};
/** Home on the lead's chat, the box open. */
export const HomeChat: Story = {
  args: {
    expanded: true,
    screen: lead,
    composer: {
      target: {
        kind: "message",
        slug: "cos",
        name: "Chief of Staff",
        channel: "cos__human",
      },
      text: "",
      listening: false,
    },
  },
};
export const HomeSessions: Story = {
  args: { expanded: true, screen: { kind: "sessions" } },
};
export const HomeNewBot: Story = {
  args: { expanded: true, screen: { kind: "new" } },
};
/** Gmail has been in front a while and is not connected: one quiet line. */
export const HomeWithHint: Story = {
  args: {
    expanded: true,
    screen: lead,
    state: {
      ...HOME_OFFICE,
      hint: {
        platform: "gmail",
        name: "Gmail",
        line: "Connect Gmail so your bots can read this inbox",
        since: "2026-10-15T09:00:00Z",
      },
    },
  },
};
/** A bot is set to run on this Mac and the grants are not there yet. */
export const HomeNeedsPermissions: Story = {
  args: {
    expanded: true,
    screen: lead,
    state: {
      ...HOME_OFFICE,
      host_wanted: true,
      permissions: { accessibility: true, screen_recording: false },
    },
  },
};
export const NoNotchMac: Story = { args: { geometry: NO_NOTCH } };
export const Connecting: Story = {
  args: { state: null, expanded: true, gang: [] },
};
