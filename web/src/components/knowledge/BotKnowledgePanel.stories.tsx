import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  BotKnowledgePage,
  BotKnowledgeResult,
  PendingPromotion,
} from "../../api/botKnowledge";
import { BotKnowledgePanel } from "./BotKnowledgePanel";

/**
 * Knowledge, scoped to one bot, with the promotion gate into the shared team
 * wiki. Stories seed the react-query cache directly rather than mounting the
 * app shell, so each promotion state renders without a broker.
 */
const meta: Meta<typeof BotKnowledgePanel> = {
  title: "Features/Knowledge/AgentKnowledgePanel",
  component: BotKnowledgePanel,
};

export default meta;
type Story = StoryObj<typeof BotKnowledgePanel>;

const BOT = "dwight";

function page(over: Partial<BotKnowledgePage> = {}): BotKnowledgePage {
  return {
    id: "notebook-dwight-beet-rotation-md",
    title: "Beet rotation",
    category: "Notebook · dwight",
    updatedAt: "",
    summary: "Four year cycle.",
    lead: "Beets go in a four year rotation, then a clover year to rest the soil.",
    sections: [
      {
        heading: "Why the clover year",
        paras: [
          "Skipping it costs about a fifth of the next yield. The rotation is not negotiable.",
        ],
      },
    ],
    categories: [],
    agent: BOT,
    sourcePath: "agents/dwight/notebook/beet-rotation.md",
    promotion: { state: "private", contentSha: "9f2c1a" },
    ...over,
  };
}

/** Seeds the query cache so the panel renders without a live broker. */
function seeded(result: BotKnowledgeResult, pending?: PendingPromotion) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["bot-knowledge", result.agent], result);
  if (pending) {
    qc.setQueryData(["knowledge-promotion", pending.requestId], pending);
  }
  return function Seeded() {
    return (
      <QueryClientProvider client={qc}>
        <BotKnowledgePanel agentSlug={result.agent} />
      </QueryClientProvider>
    );
  };
}

/** A page only this bot uses, with the promotion offer. */
export const Private: Story = {
  render: seeded({
    agent: BOT,
    wikiWritable: true,
    pages: [
      page(),
      page({
        id: "notebook-dwight-schrute-bucks-md",
        title: "Schrute bucks",
        lead: "One Schrute buck is one one-thousandth of a cent.",
        sections: [],
        sourcePath: "agents/dwight/notebook/schrute-bucks.md",
      }),
    ],
  }),
};

/**
 * The bot asked; the decision is with the human. The card shows the exact
 * snapshot that would be published, so the approval is bound to real bytes.
 */
export const WaitingOnApproval: Story = {
  render: seeded(
    {
      agent: BOT,
      wikiWritable: true,
      pages: [
        page({
          promotion: {
            state: "pending",
            contentSha: "9f2c1a4e77b0d3c8",
            requestId: "request-12",
          },
        }),
      ],
    },
    {
      requestId: "request-12",
      agent: BOT,
      sourcePath: "agents/dwight/notebook/beet-rotation.md",
      targetPath: "team/learnings/beet-rotation.md",
      title: "Beet rotation",
      content:
        "# Beet rotation\n\nBeets go in a four year rotation, then a clover year to rest the soil.\n\n## Why the clover year\n\nSkipping it costs about a fifth of the next yield.\n",
      contentSha: "9f2c1a4e77b0d3c8",
      reason: "Three people asked me the same question this week",
    },
  ),
};

/** Already in the shared wiki, with the article it became. */
export const Promoted: Story = {
  render: seeded({
    agent: BOT,
    wikiWritable: true,
    pages: [
      page({
        promotion: {
          state: "promoted",
          contentSha: "9f2c1a",
          wikiPath: "team/learnings/beet-rotation.md",
        },
      }),
    ],
  }),
};

/** A bot that has written nothing knows nothing, and says so. */
export const NothingKnownYet: Story = {
  render: seeded({ agent: "creed", wikiWritable: true, pages: [] }),
};

/** The wiki backend is down, so promotion is honestly unavailable. */
export const WikiUnavailable: Story = {
  render: seeded({ agent: BOT, wikiWritable: false, pages: [page()] }),
};
