import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotchIdeas } from "./NotchIdeas";
import type { NotchIdeas as NotchIdeasData } from "./types";

const calls: Array<[string, string]> = [];
vi.mock("./ideasApi", () => ({
  markIdeaSeen: (id: string) => {
    calls.push(["seen", id]);
    return Promise.resolve();
  },
  dismissIdea: (id: string) => {
    calls.push(["no", id]);
    return Promise.resolve();
  },
  acceptIdea: (id: string) => {
    calls.push(["yes", id]);
    return Promise.resolve({ ok: true, slug: "release-checker" });
  },
  scanIdeas: () => Promise.resolve(),
}));

const IDEAS: NotchIdeasData = {
  enabled: true,
  checked_at: "2026-10-15T09:00:00Z",
  items: [
    {
      id: "idea:aaa",
      fingerprint: "aaa",
      name: "Release Checker",
      role: "Reads what waits on the deploy",
      integration: "github",
      integration_name: "GitHub",
      promise:
        "Before #4097 goes to production, I will read every change waiting on the deploy and call go or no go.",
      rationale: "Two PRs wait on it right now.",
      cadence: "0 9 * * 1-5",
      cadence_label: "Every weekday at 9:00, while this Mac is awake",
      first_task: "Read #4097 and #4101.",
      evidence: [
        {
          id: "github-1",
          platform: "github",
          text: "#4097 Ship the new deploy pipeline",
        },
      ],
      created_at: "2026-10-15T09:00:00Z",
    },
    {
      id: "idea:bbb",
      fingerprint: "bbb",
      name: "Invoice Watcher",
      role: "",
      integration: "gmail",
      integration_name: "Gmail",
      promise: "When an invoice lands, I will log it and say so.",
      rationale: "",
      first_task: "Log the Acme invoice.",
      created_at: "2026-10-15T09:00:00Z",
    },
  ],
};

function mount(ideas = IDEAS) {
  const onOpen = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotchIdeas ideas={ideas} onOpen={onOpen} />
    </QueryClientProvider>,
  );
  return onOpen;
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(cleanup);

describe("suggested for you", () => {
  it("shows one idea at a time with its promise, counts it seen, and moves through them", async () => {
    mount();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(
      screen.getByText(/Before #4097 goes to production/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Every weekday at 9:00, while this Mac is awake"),
    ).toBeInTheDocument();
    await waitFor(() => expect(calls).toContainEqual(["seen", "idea:aaa"]));
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Show what it saw · 1" }),
    );
    expect(
      screen.getByText("#4097 Ship the new deploy pipeline"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next idea" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    await waitFor(() => expect(calls).toContainEqual(["seen", "idea:bbb"]));
  });

  it("sends an idea away on No, and makes the bot on Yes", async () => {
    const onOpen = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(calls).toContainEqual(["no", "idea:aaa"]);
    expect(screen.getByText(/Invoice Watcher/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Yes, make it and go" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("notch-idea-made")).toBeInTheDocument(),
    );
    expect(calls).toContainEqual(["yes", "idea:bbb"]);
    expect(screen.getByText("Invoice Watcher is on it.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("/agents/release-checker");
  });

  it("says when it last looked, and offers a look now, with no ideas", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotchIdeas ideas={{ enabled: true, items: [] }} onOpen={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Nothing new yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Look now" })).toBeEnabled();
  });
});
