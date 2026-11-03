import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "../api/client";
import { BUSY_OFFICE } from "./fixtures";
import { isYours, NotchThread, threadLines } from "./NotchThread";

const served: Message[] = [
  {
    id: "m2",
    from: "gemini",
    channel: "gemini__human",
    content: "Done: two tests fixed.",
    timestamp: "2026-10-15T09:02:00Z",
    tagged: [],
  },
  {
    id: "m1",
    from: "human",
    channel: "gemini__human",
    content: "Fix the flaky tests",
    timestamp: "2026-10-15T09:00:00Z",
    tagged: [],
  },
  {
    id: "m3",
    from: "gemini",
    channel: "gemini__human",
    content: "   ",
    timestamp: "2026-10-15T09:03:00Z",
    tagged: [],
  },
] as unknown as Message[];

vi.mock("../api/client", async (original) => ({
  ...(await original<typeof import("../api/client")>()),
  getMessages: () => Promise.resolve({ messages: served }),
}));

afterEach(cleanup);

const noop = () => {};

function mount(extra: Partial<Parameters<typeof NotchThread>[0]> = {}) {
  const onStop = vi.fn();
  const onOpen = vi.fn();
  const onAnswer = vi.fn();
  const onCompose = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NotchThread
        state={{
          ...BUSY_OFFICE,
          agents: BUSY_OFFICE.agents.map((a) =>
            a.slug === "gemini"
              ? { ...a, mood: "working", detail: "running the suite" }
              : a,
          ),
        }}
        screen={{
          kind: "agent",
          slug: "gemini",
          name: "Gemini CLI",
          channel: "gemini__human",
        }}
        composer={{
          target: {
            kind: "message",
            slug: "gemini",
            name: "Gemini CLI",
            channel: "gemini__human",
          },
          text: "",
          listening: false,
        }}
        sending={false}
        voiceAvailable={false}
        onComposerText={noop}
        onComposerSubmit={noop}
        onComposerCancel={noop}
        onVoice={noop}
        onKeyboard={noop}
        onOpen={onOpen}
        onStop={onStop}
        onCompose={onCompose}
        onSelect={noop}
        onAnswer={onAnswer}
        onReply={noop}
        onSend={noop}
        {...extra}
      />
    </QueryClientProvider>,
  );
  return { onStop, onOpen, onAnswer, onCompose };
}

describe("a bot's chat", () => {
  it("shows the conversation oldest first, yours on your side, with the reply box", async () => {
    mount();
    expect(await screen.findByText("Fix the flaky tests")).toBeInTheDocument();
    const texts = [...document.querySelectorAll(".nmsg-text")].map(
      (e) => e.textContent,
    );
    expect(texts).toEqual(["Fix the flaky tests", "Done: two tests fixed."]);
    expect(document.querySelector(".nmsg.is-you .nmsg-text")?.textContent).toBe(
      "Fix the flaky tests",
    );
    expect(
      screen.getByRole("textbox", { name: "Reply to Gemini CLI" }),
    ).toBeInTheDocument();
    expect(screen.getByText("running the suite")).toBeInTheDocument();
  });

  it("stops a working bot from the box, and opens the full view at the conversation", async () => {
    const { onStop, onOpen } = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Stop Gemini CLI" }));
    expect(onStop).toHaveBeenCalledWith("gemini");
    await user.click(
      screen.getByRole("button", { name: "Open Gemini CLI in full view" }),
    );
    expect(onOpen).toHaveBeenCalledWith("/channels/gemini__human");
  });

  it("shows the question the bot is waiting on inside its chat, one tap to answer", async () => {
    const { onAnswer } = mount();
    const user = userEvent.setup();
    expect(
      screen.getByRole("article", { name: "Question from Gemini CLI" }),
    ).toHaveTextContent("Send the launch email?");
    await user.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onAnswer).toHaveBeenCalledWith("req-1", "approve");
  });

  it("offers an empty box that starts a message when nothing is being typed", async () => {
    const { onCompose } = mount({ composer: null });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("notch-compose-idle"));
    expect(onCompose).toHaveBeenCalledWith({
      kind: "message",
      slug: "gemini",
      name: "Gemini CLI",
      channel: "gemini__human",
    });
  });

  it("keeps the last lines, in order, and knows which are yours", () => {
    expect(threadLines(served).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(isYours({ from: "you" })).toBe(true);
    expect(isYours({ from: "gemini" })).toBe(false);
  });
});
