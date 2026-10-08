import type { Meta, StoryObj } from "@storybook/react-vite";

import "./notch.css";

import { gang } from "./antics";
import { BUSY_OFFICE, MACBOOK_NOTCH, NO_NOTCH, QUIET_OFFICE } from "./fixtures";
import { NotchView } from "./NotchView";

const noop = () => {};
const busyGang = gang(BUSY_OFFICE.attention, BUSY_OFFICE.agents);

const meta: Meta<typeof NotchView> = {
  title: "Notch / NotchView",
  component: NotchView,
  args: {
    state: BUSY_OFFICE,
    geometry: MACBOOK_NOTCH,
    expanded: false,
    gang: busyGang,
    boredom: 0,
    line: null,
    peeker: null,
    selectedId: "req-1",
    answering: new Set(),
    composer: null,
    sending: false,
    error: null,
    soundOn: true,
    voiceAvailable: true,
    onSelect: noop,
    onAnswer: noop,
    onReply: noop,
    onComposerText: noop,
    onComposerSubmit: noop,
    onComposerCancel: noop,
    onVoice: noop,
    onOpen: noop,
    onKeyboard: noop,
    onToggleSound: noop,
    onOpenFull: noop,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          height: 620,
          background: "linear-gradient(160deg, #3b3f58, #1d2030 70%)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotchView>;

export const GangWaiting: Story = {};
export const GangFidgeting: Story = { args: { boredom: 1 } };
export const GangChatting: Story = {
  args: {
    boredom: 2,
    line: {
      speaker: "gemini",
      text: "I was here first. “Send the launch email?”",
    },
  },
};
export const AgentPeeking: Story = {
  args: { state: QUIET_OFFICE, gang: [], peeker: QUIET_OFFICE.agents[1] },
};
export const Quiet: Story = { args: { state: QUIET_OFFICE, gang: [] } };
export const Open: Story = { args: { expanded: true } };
export const OpenReplying: Story = {
  args: {
    expanded: true,
    composer: {
      target: { kind: "answer", requestId: "req-2", to: "Chief of Staff" },
      text: "Use the one we already pay for",
      listening: false,
    },
  },
};
export const OpenListening: Story = {
  args: {
    expanded: true,
    composer: {
      target: {
        kind: "message",
        slug: "codex",
        name: "Codex CLI",
        channel: "codex__human",
      },
      text: "pause the billing refactor until",
      listening: true,
    },
  },
};
export const OpenQuiet: Story = {
  args: { expanded: true, state: QUIET_OFFICE, gang: [] },
};
export const NoNotchMac: Story = { args: { geometry: NO_NOTCH } };
export const Connecting: Story = {
  args: { state: null, expanded: true, gang: [] },
};
