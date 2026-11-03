import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./notch.css";
import type { Message } from "../api/client";
import { BUSY_OFFICE } from "./fixtures";
import { NotchThread } from "./NotchThread";

const LINES: Message[] = [
  {
    id: "m1",
    from: "human",
    channel: "gemini__human",
    content: "Fix the flaky checkout test",
    timestamp: "2026-10-15T09:00:00Z",
    tagged: [],
  },
  {
    id: "m2",
    from: "gemini",
    channel: "gemini__human",
    content:
      "Done: the test waited on a timer instead of the network. Two more like it in the same file, fixed the same way.",
    timestamp: "2026-10-15T09:02:00Z",
    tagged: [],
  },
] as unknown as Message[];

const client = new QueryClient();
client.setQueryData(["notch-thread", "gemini__human"], { messages: LINES });
const noop = () => {};

const meta: Meta<typeof NotchThread> = {
  title: "Notch / Thread",
  component: NotchThread,
  args: {
    state: {
      ...BUSY_OFFICE,
      agents: BUSY_OFFICE.agents.map((a) =>
        a.slug === "gemini"
          ? { ...a, mood: "working", detail: "running the suite" }
          : a,
      ),
    },
    screen: {
      kind: "agent",
      slug: "gemini",
      name: "Gemini CLI",
      channel: "gemini__human",
    },
    composer: {
      target: {
        kind: "message",
        slug: "gemini",
        name: "Gemini CLI",
        channel: "gemini__human",
      },
      text: "",
      listening: false,
    },
    sending: false,
    voiceAvailable: true,
    onComposerText: noop,
    onComposerSubmit: noop,
    onComposerCancel: noop,
    onVoice: noop,
    onKeyboard: noop,
    onOpen: noop,
    onStop: noop,
    onCompose: noop,
    onSelect: noop,
    onAnswer: noop,
    onReply: noop,
    onSend: noop,
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <div
          className="notch-shell is-expanded"
          style={{
            position: "relative",
            width: 640,
            height: 520,
            transform: "none",
            left: 0,
          }}
        >
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotchThread>;

/** A working bot's thread, with Stop in the header and the box ready. */
export const Working: Story = {};
