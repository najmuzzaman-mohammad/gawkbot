import type { Meta, StoryObj } from "@storybook/react-vite";

import { MemberProvenance } from "./MemberProvenance";

const meta: Meta<typeof MemberProvenance> = {
  title: "Bots / MemberProvenance",
  component: MemberProvenance,
};
export default meta;

type Story = StoryObj<typeof MemberProvenance>;

export const MadeByYou: Story = {
  args: {
    member: {
      origin: "user",
      runs_on: "this_machine",
      runs_on_detail: "this machine",
      managed_by: "cos",
    },
  },
};

export const AdoptedCLI: Story = {
  args: {
    member: {
      origin: "adopted",
      runs_on: "this_machine",
      runs_on_detail: "Gemini CLI on this machine",
      managed_by: "cos",
    },
  },
};

export const RunsElsewhere: Story = {
  args: {
    member: {
      origin: "imported",
      runs_on: "elsewhere",
      runs_on_detail: "OpenClaw gateway",
      managed_by: "cos",
    },
  },
};

export const ChiefOfStaff: Story = {
  args: {
    member: {
      origin: "built_in",
      runs_on: "this_machine",
      runs_on_detail: "this machine",
    },
  },
};

export const YourSession: Story = {
  args: {
    member: {
      origin: "session",
      runs_on: "this_machine",
      runs_on_detail: "Claude Code on this machine",
      managed_by: "cos",
    },
  },
};
