import type { Meta, StoryObj } from "@storybook/react-vite";

import type { BotRuntime } from "../../lib/botRuntime";
import { BotAvatar } from "./BotAvatar";

// The runtimes a roster really holds: a pinned model, an observed one, a tool
// with no model, a local model whose id is not one we group, and a gateway.
const RUNTIMES: Array<{ slug: string; runtime: BotRuntime }> = [
  {
    slug: "cos",
    runtime: {
      harness: "claude-code",
      harness_name: "Claude Code",
      model: "claude-opus-5-5",
      model_label: "Opus 5.5",
      family: "claude",
      source: "observed",
    },
  },
  {
    slug: "cx-9f2a41c0",
    runtime: {
      harness: "codex",
      harness_name: "Codex CLI",
      model: "gpt-6-astra",
      model_label: "GPT-6 Astra",
      family: "gpt",
      source: "observed",
    },
  },
  {
    slug: "gemini",
    runtime: { harness: "cli-agent", harness_name: "Gemini CLI" },
  },
  {
    slug: "local",
    runtime: {
      harness: "ollama",
      harness_name: "Ollama",
      model: "qwen2.5-coder:32b",
      model_label: "qwen2.5-coder:32b",
      source: "binding",
    },
  },
  {
    slug: "claw",
    runtime: { harness: "openclaw", harness_name: "OpenClaw" },
  },
];

// Every avatar size the app draws, so each badge density is on screen.
const SIZES = [14, 20, 24, 36, 40, 48, 64];

const meta: Meta<typeof BotAvatar> = {
  title: "UI/BotAvatar",
  component: BotAvatar,
  args: { slug: "cos", size: 48, runtime: RUNTIMES[0].runtime },
  argTypes: {
    size: { control: { type: "range", min: 12, max: 96, step: 2 } },
    badge: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof BotAvatar>;

export const Default: Story = {};

export const WithoutBadge: Story = { args: { badge: false } };

export const EveryRuntimeAtEverySize: StoryObj = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `140px repeat(${SIZES.length}, 96px)`,
        rowGap: 28,
        alignItems: "center",
        padding: 24,
        background: "var(--bg)",
        color: "var(--text-secondary)",
        fontSize: 11,
      }}
    >
      <span />
      {SIZES.map((size) => (
        <span key={size}>{size}px</span>
      ))}
      {RUNTIMES.map(({ slug, runtime }) => (
        <div key={slug} style={{ display: "contents" }}>
          <span>{runtime.model_label ?? runtime.harness_name}</span>
          {SIZES.map((size) => (
            <span key={size}>
              <BotAvatar slug={slug} size={size} runtime={runtime} />
            </span>
          ))}
        </div>
      ))}
    </div>
  ),
};

// The badge must not push a row around: a name sits beside the avatar the
// way it does in the sidebar and in a message.
export const BesideAName: StoryObj = {
  render: () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 24,
        background: "var(--bg-card)",
        color: "var(--text)",
        fontSize: 13,
        width: 260,
      }}
    >
      {RUNTIMES.map(({ slug, runtime }) => (
        <div
          key={slug}
          style={{ display: "flex", alignItems: "center", gap: 10 }}
        >
          <BotAvatar slug={slug} size={24} runtime={runtime} />
          <span>{slug}</span>
        </div>
      ))}
    </div>
  ),
};
