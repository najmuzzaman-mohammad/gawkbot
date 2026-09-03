/**
 * Bot knowledge API client.
 *
 * Knowledge is what a given BOT knows: the pages in that bot's own
 * notebook, read straight off the wiki repo. It is private to that bot until
 * a human promotes it into the shared team wiki.
 *
 * Two promotion paths, one gate:
 *  - `promoteBotKnowledge`  a human promoting a page they are reading.
 *  - `requestKnowledgePromotion`  a bot asking a human to approve one.
 *
 * The human path is bound to content: `contentSha` is the hash of the page the
 * reader displayed, and the broker refuses the promotion when the note has
 * changed since. That is deliberate — a promotion publishes to a shared,
 * trusted surface, so the bytes that land must be the bytes that were read.
 */

import { get, post } from "./client";

/** Where a page stands with the shared wiki. */
export type KnowledgePromotionState = "private" | "pending" | "promoted";

export interface KnowledgePromotionStatus {
  state: KnowledgePromotionState;
  /** The team/ article this page became. Set when state is "promoted". */
  wikiPath?: string;
  /** The open approval card. Set when state is "pending". */
  requestId?: string;
  /** sha256 of the note as read. Echoed back on promote. */
  contentSha: string;
}

export interface BotKnowledgeSection {
  heading?: string;
  paras: string[];
}

/**
 * One page a bot knows. The shape is the broker's knowledge page; the
 * bot-scoped fields (`bot`, `sourcePath`, `promotion`) are what make it
 * attributable and promotable.
 */
export interface BotKnowledgePage {
  id: string;
  title: string;
  category: string;
  updatedAt: string;
  summary: string;
  lead: string;
  sections: BotKnowledgeSection[];
  categories: string[];
  agent?: string;
  sourcePath?: string;
  promotion?: KnowledgePromotionStatus;
}

export interface BotKnowledgeResult {
  agent: string;
  pages: BotKnowledgePage[];
  /**
   * False when the markdown wiki backend is not running, so nothing can be
   * promoted right now. The UI says that plainly instead of offering a button
   * that would fail.
   */
  wikiWritable: boolean;
}

/** Read everything one bot knows. A bot with no notes returns no pages. */
export async function getBotKnowledge(
  agentSlug: string,
): Promise<BotKnowledgeResult> {
  const res = await get<{
    agent?: string;
    pages?: BotKnowledgePage[];
    wiki_writable?: boolean;
  }>("/agent-knowledge", { agent: agentSlug });
  return {
    agent: res.agent ?? agentSlug,
    pages: res.pages ?? [],
    wikiWritable: res.wiki_writable ?? false,
  };
}

export interface PromoteBotKnowledgeInput {
  agentSlug: string;
  sourcePath: string;
  /** The hash the reader displayed. Required — see the module comment. */
  contentSha: string;
  /** Optional `team/<section>/<slug>.md` override. */
  targetPath?: string;
}

export interface PromoteBotKnowledgeResult {
  path: string;
  commitSha: string;
}

/** Promote a page into the shared wiki. Human-only; the broker enforces that. */
export async function promoteBotKnowledge(
  input: PromoteBotKnowledgeInput,
): Promise<PromoteBotKnowledgeResult> {
  const res = await post<{ path?: string; commit_sha?: string }>(
    "/agent-knowledge/promote",
    {
      agent: input.agentSlug,
      source_path: input.sourcePath,
      content_sha: input.contentSha,
      ...(input.targetPath ? { target_path: input.targetPath } : {}),
    },
  );
  return { path: res.path ?? "", commitSha: res.commit_sha ?? "" };
}

/**
 * The immutable snapshot behind one pending promotion: exactly what the broker
 * will write if the human approves. `content` is the note as it was when the
 * bot asked, NOT a re-read — editing the note afterwards does not change it.
 */
export interface PendingPromotion {
  requestId: string;
  agent: string;
  sourcePath: string;
  targetPath: string;
  title: string;
  content: string;
  contentSha: string;
  reason?: string;
}

/**
 * Read the snapshot attached to a pending promotion approval, so the human can
 * review the exact bytes before answering. Returns null when the request is
 * gone or is not a promotion.
 */
export async function getPendingPromotion(
  requestId: string,
): Promise<PendingPromotion | null> {
  const res = await get<{
    requests?: Array<{
      id?: string;
      knowledge_promotion?: {
        agent?: string;
        source_path?: string;
        target_path?: string;
        title?: string;
        content?: string;
        content_sha?: string;
        reason?: string;
      };
    }>;
  }>("/requests", { id: requestId, viewer_slug: "human" });
  const found = res.requests?.find((r) => r.id === requestId);
  const promo = found?.knowledge_promotion;
  if (!(found && promo)) return null;
  return {
    requestId,
    agent: promo.agent ?? "",
    sourcePath: promo.source_path ?? "",
    targetPath: promo.target_path ?? "",
    title: promo.title ?? "",
    content: promo.content ?? "",
    contentSha: promo.content_sha ?? "",
    reason: promo.reason,
  };
}

/**
 * Answer a pending promotion. Approving promotes the snapshot above and nothing
 * else; rejecting leaves the page exactly where it is.
 */
export async function answerPromotionRequest(
  requestId: string,
  decision: "approve" | "reject",
): Promise<void> {
  await post("/requests/answer", {
    id: requestId,
    choice_id: decision,
    choice_text: decision === "approve" ? "Approve" : "Reject",
  });
}

export interface RequestKnowledgePromotionInput {
  agentSlug: string;
  sourcePath: string;
  reason?: string;
  targetPath?: string;
}

/**
 * Raise the approval card a bot uses to ask for a promotion. Returns the
 * request id. Nothing reaches the wiki until a human answers it.
 */
export async function requestKnowledgePromotion(
  input: RequestKnowledgePromotionInput,
): Promise<{ requestId: string }> {
  const res = await post<{ request_id?: string }>(
    "/agent-knowledge/promotion-request",
    {
      agent: input.agentSlug,
      source_path: input.sourcePath,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.targetPath ? { target_path: input.targetPath } : {}),
    },
  );
  return { requestId: res.request_id ?? "" };
}
