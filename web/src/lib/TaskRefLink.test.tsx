/**
 * Tests for the inline task-reference link.
 *
 * Two behaviours worth pinning: the label resolves to the task's TITLE from
 * the board cache (a bare id tells the reader nothing), and a click opens the
 * shared modal instead of navigating.
 */

import ReactMarkdown from "react-markdown";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskListResponse } from "../api/tasks";
import { useAppStore } from "../stores/app";
import {
  messageMarkdownComponents,
  messageRemarkPlugins,
} from "./messageMarkdown";
import { router } from "./router";

function makeTask(overrides: Partial<Task>): Task {
  return { id: "DUNDE-72", title: "Task", status: "open", ...overrides };
}

function renderWithTasks(content: string, tasks: Task[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const payload: TaskListResponse = { tasks };
  client.setQueryData(["issues", "list"], payload);
  return render(
    <QueryClientProvider client={client}>
      <ReactMarkdown
        remarkPlugins={messageRemarkPlugins}
        components={messageMarkdownComponents}
        skipHtml={true}
      >
        {content}
      </ReactMarkdown>
    </QueryClientProvider>,
  );
}

describe("<TaskRefLink>", () => {
  beforeEach(() => {
    useAppStore.setState({ taskModalTaskId: null });
  });

  it("renders the task's title, not the bare id", () => {
    renderWithTasks("blocked on DUNDE-72 right now", [
      makeTask({ id: "DUNDE-72", title: "Ship the Q3 pricing page" }),
    ]);
    expect(
      screen.getByRole("button", { name: /Ship the Q3 pricing page/ }),
    ).toHaveTextContent("Ship the Q3 pricing page");
  });

  it("keeps the id discoverable in the tooltip", () => {
    const { container } = renderWithTasks("see DUNDE-72", [
      makeTask({ id: "DUNDE-72", title: "Ship the Q3 pricing page" }),
    ]);
    expect(container.querySelector(".msg-task-link")).toHaveAttribute(
      "title",
      "DUNDE-72 · Ship the Q3 pricing page",
    );
  });

  it("falls back to the raw id when the task is not in the cache", () => {
    const { container } = renderWithTasks("see DUNDE-99", [
      makeTask({ id: "DUNDE-72", title: "Ship the Q3 pricing page" }),
    ]);
    expect(container.querySelector(".msg-task-link")).toHaveTextContent(
      "DUNDE-99",
    );
  });

  it("strips the self-heal provenance prefix from the label", () => {
    const { container } = renderWithTasks("see DUNDE-72", [
      makeTask({ id: "DUNDE-72", title: "[@ceo] Bot stuck on: VC outreach" }),
    ]);
    expect(container.querySelector(".msg-task-link")).toHaveTextContent(
      "Bot stuck on: VC outreach",
    );
  });

  it("opens the task modal on click and does NOT navigate", async () => {
    const navigate = vi.spyOn(router, "navigate").mockResolvedValue(undefined);
    renderWithTasks("blocked on DUNDE-72", [
      makeTask({ id: "DUNDE-72", title: "Ship the Q3 pricing page" }),
    ]);

    await userEvent.click(
      screen.getByRole("button", { name: /Ship the Q3 pricing page/ }),
    );

    expect(useAppStore.getState().taskModalTaskId).toBe("DUNDE-72");
    expect(navigate).not.toHaveBeenCalled();
    navigate.mockRestore();
  });
});
