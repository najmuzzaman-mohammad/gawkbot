import type { Meta, StoryObj } from "@storybook/react-vite";

import "./notch.css";
import { BUSY_OFFICE, MACBOOK_NOTCH, NO_NOTCH, QUIET_OFFICE } from "./fixtures";
import { NotchView } from "./NotchView";

const noop = () => {};

const meta: Meta<typeof NotchView> = {
  title: "Notch / NotchView",
  component: NotchView,
  args: {
    state: BUSY_OFFICE,
    geometry: MACBOOK_NOTCH,
    expanded: false,
    onAnswer: noop,
    onSend: noop,
    onOpen: noop,
    onKeyboard: noop,
  },
  decorators: [
    // A slice of desktop wallpaper with the menu bar, so the strip reads
    // against what it really sits on.
    (Story) => (
      <div
        style={{
          position: "relative",
          height: 460,
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

export const CollapsedNeedsYou: Story = {};
export const CollapsedQuiet: Story = { args: { state: QUIET_OFFICE } };
export const Expanded: Story = { args: { expanded: true } };
export const ExpandedQuiet: Story = {
  args: { expanded: true, state: QUIET_OFFICE },
};
export const NoNotchMac: Story = { args: { geometry: NO_NOTCH } };
export const Connecting: Story = { args: { state: null, expanded: true } };
export const SendFailed: Story = {
  args: { expanded: true, error: "Could not send that message" },
};
