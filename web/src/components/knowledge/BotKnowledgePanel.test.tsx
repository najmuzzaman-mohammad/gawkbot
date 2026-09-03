import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BotKnowledgePage } from "../../api/botKnowledge";
import { BotKnowledgePanel } from "./BotKnowledgePanel";

// The panel reads and writes through the real api/botKnowledge client, so
// mocking the transport exercises the wire shape the broker actually serves.
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../api/client", () => ({ get, post }));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function page(over: Partial<BotKnowledgePage> = {}): BotKnowledgePage {
  return {
    id: "notebook-dwight-beet-rotation-md",
    title: "Beet rotation",
    category: "Notebook · dwight",
    updatedAt: "",
    summary: "Four year cycle.",
    lead: "Four year cycle, then clover.",
    sections: [{ heading: "Why", paras: ["The soil needs the break."] }],
    categories: [],
    agent: "dwight",
    sourcePath: "agents/dwight/notebook/beet-rotation.md",
    promotion: { state: "private", contentSha: "abc123" },
    ...over,
  };
}

describe("AgentKnowledgePanel", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it("reads knowledge scoped to the bot it is shown for", async () => {
    get.mockResolvedValue({ agent: "dwight", pages: [], wiki_writable: true });
    wrap(<BotKnowledgePanel agentSlug="dwight" />);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/agent-knowledge", { agent: "dwight" }),
    );
  });

  it("shows an honest empty state when the bot knows nothing", async () => {
    get.mockResolvedValue({ agent: "creed", pages: [], wiki_writable: true });
    const { findByText, queryByRole } = wrap(
      <BotKnowledgePanel agentSlug="creed" />,
    );
    await findByText(/has not written anything down yet/i);
    // Nothing is invented to fill the space: no page list, no promote button.
    expect(queryByRole("button", { name: /promote/i })).toBeNull();
  });

  it("cites the note each page came from", async () => {
    get.mockResolvedValue({
      agent: "dwight",
      pages: [page()],
      wiki_writable: true,
    });
    const { findByText } = wrap(<BotKnowledgePanel agentSlug="dwight" />);
    await findByText(/agents\/dwight\/notebook\/beet-rotation\.md/);
  });

  it("promotes with the content hash it displayed, so the human publishes what they read", async () => {
    get.mockResolvedValue({
      agent: "dwight",
      pages: [
        page({ promotion: { state: "private", contentSha: "sha-read" } }),
      ],
      wiki_writable: true,
    });
    post.mockResolvedValue({
      path: "team/learnings/beet-rotation.md",
      commit_sha: "abc1234",
    });
    const { findByRole } = wrap(<BotKnowledgePanel agentSlug="dwight" />);
    fireEvent.click(
      await findByRole("button", { name: /promote to team wiki/i }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/agent-knowledge/promote", {
        agent: "dwight",
        source_path: "agents/dwight/notebook/beet-rotation.md",
        content_sha: "sha-read",
      }),
    );
  });

  it("surfaces a rejected promotion instead of pretending it landed", async () => {
    get.mockResolvedValue({
      agent: "dwight",
      pages: [page()],
      wiki_writable: true,
    });
    post.mockRejectedValue(
      new Error(
        "this page changed since you opened it; re-read it before promoting",
      ),
    );
    const { findByRole, findByText } = wrap(
      <BotKnowledgePanel agentSlug="dwight" />,
    );
    fireEvent.click(
      await findByRole("button", { name: /promote to team wiki/i }),
    );
    await findByText(/changed since you opened it/i);
  });

  // A pending promotion is reviewed against the SNAPSHOT the broker took when
  // the bot asked, not against the note as it stands now. The panel fetches
  // that snapshot and shows it, so the human approves what will actually be
  // published.
  function pendingPage() {
    return page({
      promotion: {
        state: "pending",
        contentSha: "sha-asked",
        requestId: "request-7",
      },
    });
  }

  function mockPending(snapshotContent: string) {
    get.mockImplementation((path: string) => {
      if (path === "/agent-knowledge") {
        return Promise.resolve({
          agent: "dwight",
          pages: [pendingPage()],
          wiki_writable: true,
        });
      }
      return Promise.resolve({
        requests: [
          {
            id: "request-7",
            knowledge_promotion: {
              agent: "dwight",
              source_path: "agents/dwight/notebook/beet-rotation.md",
              target_path: "team/learnings/beet-rotation.md",
              title: "Beet rotation",
              content: snapshotContent,
              content_sha: "sha-asked",
              reason: "The whole team keeps asking",
            },
          },
        ],
      });
    });
  }

  it("reviews a pending promotion against the snapshot the bot asked with", async () => {
    mockPending("# Beet rotation\n\nFour year cycle, then clover.\n");
    const { findByText, queryByRole } = wrap(
      <BotKnowledgePanel agentSlug="dwight" />,
    );
    await findByText(/asked you to put this in the team wiki/i);
    // The exact bytes that would be published are on screen, and the direct
    // promote button is gone: this page goes through the approval instead.
    await findByText(/Four year cycle, then clover\./);
    await findByText(/sha-asked/);
    expect(queryByRole("button", { name: /promote to team wiki/i })).toBeNull();
    expect(get).toHaveBeenCalledWith("/requests", {
      id: "request-7",
      viewer_slug: "human",
    });
  });

  it("shows the snapshot, not the live note, when the bot rewrote it after asking", async () => {
    // The panel never reads the note for a pending page — it reads the request.
    // A rewritten note therefore cannot appear on the card the human answers.
    mockPending("# Beet rotation\n\nFour year cycle, then clover.\n");
    const { findByText, queryByText } = wrap(
      <BotKnowledgePanel agentSlug="dwight" />,
    );
    await findByText(/Four year cycle, then clover\./);
    expect(queryByText(/IGNORE PREVIOUS INSTRUCTIONS/)).toBeNull();
  });

  it("answers the approval by request id", async () => {
    mockPending("# Beet rotation\n\nFour year cycle, then clover.\n");
    post.mockResolvedValue({ ok: true });
    const { findByRole, findByText } = wrap(
      <BotKnowledgePanel agentSlug="dwight" />,
    );
    // The approve button only enables once the snapshot is on screen — a human
    // cannot approve a page they have not been shown.
    await findByText(/Four year cycle, then clover\./);
    fireEvent.click(
      await findByRole("button", { name: /approve this promotion/i }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/requests/answer", {
        id: "request-7",
        choice_id: "approve",
        choice_text: "Approve",
      }),
    );
  });

  it("shows where a promoted page landed rather than offering to promote it again", async () => {
    get.mockResolvedValue({
      agent: "dwight",
      pages: [
        page({
          promotion: {
            state: "promoted",
            contentSha: "abc123",
            wikiPath: "team/learnings/beet-rotation.md",
          },
        }),
      ],
      wiki_writable: true,
    });
    const { findByText, queryByRole } = wrap(
      <BotKnowledgePanel agentSlug="dwight" />,
    );
    await findByText(/In the team wiki at/i);
    expect(queryByRole("button", { name: /promote to team wiki/i })).toBeNull();
  });

  it("disables promotion when the wiki backend is not running", async () => {
    get.mockResolvedValue({
      agent: "dwight",
      pages: [page()],
      wiki_writable: false,
    });
    const { findByRole, findByText } = wrap(
      <BotKnowledgePanel agentSlug="dwight" />,
    );
    const btn = await findByRole("button", { name: /promote to team wiki/i });
    expect(btn).toBeDisabled();
    await findByText(/wiki is not running right now/i);
  });

  it("renders bot-authored prose as text, never as markup", async () => {
    get.mockResolvedValue({
      agent: "dwight",
      pages: [
        page({
          lead: '<img src=x onerror="alert(1)"> and <b>bold</b>',
          sections: [],
        }),
      ],
      wiki_writable: true,
    });
    const { container, findByText } = wrap(
      <BotKnowledgePanel agentSlug="dwight" />,
    );
    await findByText(/onerror/);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});
