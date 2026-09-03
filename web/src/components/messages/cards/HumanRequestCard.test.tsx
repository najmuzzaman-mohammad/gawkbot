import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BotRequest } from "../../../api/client";

// Mocks installed BEFORE the component import so it picks them up.
const useRequestsMock = vi.fn();
vi.mock("../../../hooks/useRequests", () => ({
  useRequests: () => useRequestsMock(),
}));

vi.mock("../../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../../api/client")>(
    "../../../api/client",
  );
  return { ...actual, answerRequest: vi.fn().mockResolvedValue({}) };
});

import * as clientMod from "../../../api/client";
import { HumanRequestCard } from "./HumanRequestCard";

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function setRequests(reqs: BotRequest[]): void {
  useRequestsMock.mockReturnValue({
    all: reqs,
    pending: reqs,
    blockingPending: reqs.find((r) => r.blocking) ?? null,
  });
}

/** The live request behind the founder's screenshot. */
function prospectorRequest(over: Partial<BotRequest> = {}): BotRequest {
  return {
    id: "request-3",
    from: "ceo",
    question: "Add Prospector to the team?",
    kind: "decision",
    blocking: true,
    status: "pending",
    options: [
      { id: "add", label: "Add them" },
      { id: "not_now", label: "Not now" },
    ],
    ...over,
  } as BotRequest;
}

const payload = {
  request_id: "request-3",
  from: "ceo",
  question: "Add Prospector to the team?",
  label: "request",
  blocking: true,
};

describe("<HumanRequestCard>", () => {
  it("renders the ask as controls, attributed to the bot that asked", () => {
    // Observed live 2026-09-03: this ask rendered as a sentence from a
    // phantom "Office" speaker telling the human to go answer it in an Inbox
    // the nav no longer has. The ask must carry its own buttons, and must
    // name the real asker.
    setRequests([prospectorRequest()]);

    render(wrap(<HumanRequestCard payload={payload} />));

    expect(screen.getByText("@ceo")).toBeInTheDocument();
    expect(screen.getByText("Add Prospector to the team?")).toBeInTheDocument();
    // The options are real buttons, not prose.
    expect(
      screen.getByRole("button", { name: "Add them" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    // Blocking asks say so.
    expect(screen.getByText("Blocking")).toBeInTheDocument();
    // The dead pointer is gone.
    expect(screen.queryByText(/Inbox/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Office/i)).not.toBeInTheDocument();
  });

  it("answers the request in place when an option is clicked", async () => {
    setRequests([prospectorRequest()]);

    render(wrap(<HumanRequestCard payload={payload} />));
    fireEvent.click(screen.getByRole("button", { name: "Add them" }));

    await waitFor(() => {
      expect(clientMod.answerRequest).toHaveBeenCalledWith(
        "request-3",
        "add",
        undefined,
      );
    });
  });

  it("switches to a text box for an option that requires one", async () => {
    setRequests([
      prospectorRequest({
        options: [
          { id: "add", label: "Add them" },
          {
            id: "other",
            label: "Something else",
            requires_text: true,
            text_hint: "What should they do instead?",
          },
        ],
      }),
    ]);

    render(wrap(<HumanRequestCard payload={payload} />));
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));

    const box = await screen.findByPlaceholderText(
      "What should they do instead?",
    );
    fireEvent.change(box, { target: { value: "Have them qualify inbound" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Send as Something else" }),
    );

    await waitFor(() => {
      expect(clientMod.answerRequest).toHaveBeenCalledWith(
        "request-3",
        "other",
        "Have them qualify inbound",
      );
    });
  });

  it("settles into a resolved card once the request is gone", () => {
    // Scrollback must not show live buttons for a decision already made —
    // whether it was answered here, on the Tasks board, or in the docked bar.
    setRequests([]);

    render(wrap(<HumanRequestCard payload={payload} />));

    expect(screen.getByTestId("human-request-settled")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add them" }),
    ).not.toBeInTheDocument();
    // The question stays readable so the thread still makes sense later.
    expect(screen.getByText("Add Prospector to the team?")).toBeInTheDocument();
  });

  it("falls back to the prose body when the payload predates the card", () => {
    // Messages raised before the payload existed still have to render.
    setRequests([]);

    render(
      wrap(
        <HumanRequestCard
          payload={{}}
          fallbackText="Add Prospector to the team?"
        />,
      ),
    );

    expect(screen.getByText("Add Prospector to the team?")).toBeInTheDocument();
  });
});
