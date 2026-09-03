import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { useAppStore } from "../../stores/app";
import { BotEventPill, BotEventTickProvider } from "./BotEventPill";

const meta: Meta<typeof BotEventPill> = {
  title: "Features/Agents/AgentEventPill",
  component: BotEventPill,
  decorators: [
    (Story) => (
      <BotEventTickProvider>
        <div
          style={{
            background: "var(--surface-2, #f5f5f5)",
            padding: 12,
            width: 220,
            borderRadius: 6,
          }}
        >
          <Story />
        </div>
      </BotEventTickProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BotEventPill>;

function seedSnapshot(snap: {
  slug: string;
  activity?: string;
  detail?: string;
  kind?: "routine" | "milestone" | "stuck";
  ageSeconds?: number;
}) {
  const ageMs = (snap.ageSeconds ?? 0) * 1000;
  useAppStore.setState((state) => ({
    botActivitySnapshots: {
      ...state.botActivitySnapshots,
      [snap.slug]: {
        slug: snap.slug,
        activity: snap.activity,
        detail: snap.detail,
        kind: snap.kind,
        receivedAtMs: Date.now() - ageMs,
        haloUntilMs: Date.now() - ageMs + 2500,
      },
    },
  }));
}

function useSeed(snap: Parameters<typeof seedSnapshot>[0]) {
  // Key the effect on the serialized snapshot so a fresh object literal at
  // each call site does not retrigger seeding on every render.
  const snapKey = JSON.stringify(snap);
  // biome-ignore lint/correctness/useExhaustiveDependencies: snap is intentionally tracked via snapKey
  useEffect(() => {
    seedSnapshot(snap);
  }, [snapKey]);
}

export const Halo: Story = {
  render: () => {
    useSeed({
      slug: "atlas",
      activity: "writing migration plan",
      kind: "milestone",
      ageSeconds: 0,
    });
    return <BotEventPill slug="atlas" agentRole="engineer" />;
  },
};

export const Holding: Story = {
  render: () => {
    useSeed({
      slug: "lina",
      activity: "running tests",
      kind: "routine",
      ageSeconds: 6,
    });
    return <BotEventPill slug="lina" agentRole="engineer" />;
  },
};

export const Idle: Story = {
  render: () => {
    useSeed({
      slug: "sage",
      activity: "drafting wiki entry",
      ageSeconds: 90,
    });
    return (
      <BotEventPill
        slug="sage"
        agentRole="writer"
        fallbackTask="curating reference docs"
      />
    );
  },
};

export const Stuck: Story = {
  render: () => {
    useSeed({
      slug: "ops",
      activity: "waiting on user",
      kind: "stuck",
      ageSeconds: 5,
    });
    return <BotEventPill slug="ops" agentRole="ops" />;
  },
};
