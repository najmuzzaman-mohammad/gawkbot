import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TeachWorkflowModal } from "./TeachWorkflowModal";

// Only the HTTP boundary is mocked: observeClient, readEventStream,
// reduceObserved and the seed formatter all run for real, so these tests cover
// the whole screenshare -> bot-DM chain rather than a stubbed middle.
const { postStream, postMessage } = vi.hoisted(() => ({
  postStream: vi.fn(),
  postMessage: vi.fn(),
}));
vi.mock("../../api/client", () => ({ postStream, postMessage }));

interface FakeObserveStream {
  push: (frame: string) => void;
}

/**
 * Stand in for the broker streaming runner/cua_observe.py. The abort signal is
 * wired to error the stream exactly as a real aborted fetch would, so pressing
 * Stop (and closing the modal) exercises the component's real abort path.
 */
function mockObserveStream(): FakeObserveStream {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const response = new Response(body, { status: 200 });
  postStream.mockImplementation(
    (_path: string, _body: unknown, opts?: { signal?: AbortSignal }) => {
      opts?.signal?.addEventListener("abort", () => {
        try {
          ctrl.error(new DOMException("aborted", "AbortError"));
        } catch {
          // Already closed or errored — nothing to abort.
        }
      });
      return Promise.resolve(response);
    },
  );
  return { push: (frame) => ctrl.enqueue(enc.encode(frame)) };
}

function snapshotFrame(app: string, title: string, labels: string[]): string {
  const payload = {
    type: "snapshot",
    tick: 1,
    app,
    title,
    components: labels.map((label) => ({ role: "Button", label })),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function renderModal(
  props: Partial<Parameters<typeof TeachWorkflowModal>[0]> = {},
) {
  const view = render(
    <TeachWorkflowModal
      agentSlug="planner"
      agentName="Planner"
      open={true}
      onClose={vi.fn()}
      {...props}
    />,
  );
  const start = (goal: string) => {
    fireEvent.change(
      view.getByLabelText("What are you about to show Planner?"),
      {
        target: { value: goal },
      },
    );
    fireEvent.click(view.getByRole("button", { name: /start screenshare/i }));
  };
  return { ...view, start };
}

describe("TeachWorkflowModal", () => {
  beforeEach(() => {
    postStream.mockReset();
    postMessage.mockReset();
    postMessage.mockResolvedValue({ id: "msg-1" });
  });

  it("does not read the screen until the operator explicitly starts", () => {
    mockObserveStream();
    renderModal();
    expect(postStream).not.toHaveBeenCalled();
  });

  it("requires the operator to name the job before sharing the screen", () => {
    const { getByRole, getByLabelText } = renderModal();
    const start = getByRole("button", { name: /start screenshare/i });
    expect(start).toBeDisabled();
    fireEvent.change(getByLabelText("What are you about to show Planner?"), {
      target: { value: "File the weekly expense report" },
    });
    expect(start).toBeEnabled();
  });

  it("records against the real observe endpoint and says capture is running", async () => {
    mockObserveStream();
    const view = renderModal();
    view.start("File the weekly expense report");
    await waitFor(() =>
      expect(postStream).toHaveBeenCalledWith(
        "/observe/browser",
        {},
        expect.objectContaining({ signal: expect.anything() }),
      ),
    );
    expect(view.getByText(/Reading your screen/)).toBeInTheDocument();
    expect(
      view.getByRole("button", { name: /stop screenshare/i }),
    ).toBeInTheDocument();
  });

  it("renders only the screens the observer actually reported", async () => {
    const stream = mockObserveStream();
    const view = renderModal();
    view.start("File the weekly expense report");
    await waitFor(() => expect(postStream).toHaveBeenCalled());

    stream.push(snapshotFrame("Google Chrome", "Expensify | New", ["Submit"]));
    await waitFor(() =>
      expect(view.getByText("Expensify | New")).toBeInTheDocument(),
    );
    expect(view.getByText("Google Chrome")).toBeInTheDocument();
    expect(view.getByText(/Button:Submit/)).toBeInTheDocument();
    // Nothing beyond what the observer reported.
    expect(view.queryByText(/Slack/)).not.toBeInTheDocument();
  });

  it("sends the captured workflow into the bot's own DM channel", async () => {
    const stream = mockObserveStream();
    const view = renderModal();
    view.start("File the weekly expense report");
    await waitFor(() => expect(postStream).toHaveBeenCalled());

    stream.push(snapshotFrame("Google Chrome", "Expensify | New", ["Submit"]));
    await waitFor(() =>
      expect(view.getByText("Expensify | New")).toBeInTheDocument(),
    );

    fireEvent.click(view.getByRole("button", { name: /stop screenshare/i }));
    const send = await waitFor(() =>
      view.getByRole("button", { name: /send to planner/i }),
    );
    fireEvent.click(send);

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const [content, channel] = postMessage.mock.calls[0] as [string, string];
    expect(channel).toBe("human__planner");
    expect(content).toContain("File the weekly expense report");
    expect(content).toContain("Google Chrome — Expensify | New");
    expect(content).toContain("Button:Submit");
    expect(view.getByText("Sent to Planner")).toBeInTheDocument();
  });

  // The honest-degradation contract: no observer on this host means SAY SO and
  // point at the chat path that works. It must never render a fake recording.
  it("says plainly when the host cannot read the screen, and offers the chat", async () => {
    postStream.mockResolvedValue(new Response(null, { status: 503 }));
    const view = renderModal();
    view.start("File the weekly expense report");

    await waitFor(() =>
      expect(
        view.getByText("This computer cannot read your screen"),
      ).toBeInTheDocument(),
    );
    expect(view.queryByText(/Reading your screen/)).not.toBeInTheDocument();
    expect(
      view.queryByRole("button", { name: /send to planner/i }),
    ).not.toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("reports a failed capture instead of pretending it worked", async () => {
    postStream.mockResolvedValue(new Response(null, { status: 500 }));
    const view = renderModal();
    view.start("File the weekly expense report");
    await waitFor(() =>
      expect(view.getByText("The reading stopped")).toBeInTheDocument(),
    );
    expect(view.getByText(/nothing was sent/i)).toBeInTheDocument();
  });

  it("says the bot has not seen anything when the send fails", async () => {
    const stream = mockObserveStream();
    postMessage.mockRejectedValue(new Error("broker offline"));
    const view = renderModal();
    view.start("File the weekly expense report");
    await waitFor(() => expect(postStream).toHaveBeenCalled());
    stream.push(snapshotFrame("Google Chrome", "Expensify | New", ["Submit"]));
    await waitFor(() =>
      expect(view.getByText("Expensify | New")).toBeInTheDocument(),
    );
    fireEvent.click(view.getByRole("button", { name: /stop screenshare/i }));
    fireEvent.click(
      await waitFor(() =>
        view.getByRole("button", { name: /send to planner/i }),
      ),
    );

    await waitFor(() =>
      expect(view.getByText("This did not reach the bot")).toBeInTheDocument(),
    );
    expect(view.getByText(/has not seen any of it/i)).toBeInTheDocument();
  });

  // Screen reading must never outlive the visible banner.
  it("aborts the capture when the modal is closed", async () => {
    mockObserveStream();
    const view = renderModal();
    view.start("File the weekly expense report");
    await waitFor(() => expect(postStream).toHaveBeenCalled());

    const { signal } = postStream.mock.calls[0][2] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);

    fireEvent.click(view.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("renders nothing while closed", () => {
    const view = renderModal({ open: false });
    expect(view.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
