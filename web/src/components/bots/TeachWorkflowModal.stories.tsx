import type { Meta, StoryObj } from "@storybook/react-vite";

import { TeachWorkflowModal } from "./TeachWorkflowModal";

/**
 * The screenshare flow, mounted on its own so the modal chrome, the recording
 * banner, and the "no observer" state can be checked in all three themes
 * without a bot route behind it.
 *
 * Storybook has no broker, so `Idle` is the only state that reaches a real
 * endpoint — pressing "Start screenshare" here lands on the capture-failed
 * state, which is the correct honest answer for a host with no observer.
 */
const meta: Meta<typeof TeachWorkflowModal> = {
  title: "Features/Agents/TeachWorkflowModal",
  component: TeachWorkflowModal,
  parameters: { layout: "fullscreen" },
  args: {
    agentSlug: "planner",
    agentName: "Planner",
    open: true,
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof TeachWorkflowModal>;

/** The opening state: nothing is being read until the operator says so. */
export const Idle: Story = {};

/** Slug-only bot — the copy falls back to the slug with no blank spots. */
export const NoDisplayName: Story = {
  args: { agentName: undefined },
};

/** Closed renders nothing at all, so the flow cannot run out of sight. */
export const Closed: Story = {
  args: { open: false },
};
