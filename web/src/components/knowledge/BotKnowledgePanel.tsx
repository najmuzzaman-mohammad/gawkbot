/**
 * BotKnowledgePanel — Knowledge, scoped to one bot.
 *
 * Knowledge is what THIS bot knows: the pages in its own notebook. It is
 * private to the bot until a human promotes it into the team wiki, which is
 * the shared, trusted surface everyone reads.
 *
 * Two ways a page gets promoted, one gate:
 *  - A human reads a page here and promotes it.
 *  - The bot judges a page worth sharing and asks; the request lands in the
 *    decision inbox as an approval card, and nothing moves until it is answered.
 *
 * Nothing on this surface is invented. A bot that has written nothing shows
 * an empty state, not a placeholder page, and every page names the note it came
 * from so a reader can go check.
 *
 * Rendering note: page text is rendered as TEXT. Bot-authored prose never
 * reaches the DOM as markup — no dangerouslySetInnerHTML, here or anywhere
 * downstream of it.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  BotKnowledgePage,
  KnowledgePromotionState,
} from "../../api/botKnowledge";
import {
  answerPromotionRequest,
  getBotKnowledge,
  getPendingPromotion,
  promoteBotKnowledge,
} from "../../api/botKnowledge";
import "../../styles/bot-knowledge.css";

const PROMOTION_LABEL: Record<KnowledgePromotionState, string> = {
  private: "Private",
  pending: "Waiting on you",
  promoted: "In the wiki",
};

interface BotKnowledgePanelProps {
  agentSlug: string;
}

/** The state pill on a page row: private, waiting on a human, or promoted. */
function PromotionPill({ state }: { state: KnowledgePromotionState }) {
  if (state === "private") return null;
  return (
    <span className={`bot-knowledge-pill is-${state}`}>
      {PROMOTION_LABEL[state]}
    </span>
  );
}

/**
 * The review for a promotion a bot asked for.
 *
 * This renders the SNAPSHOT the broker took when the bot asked — the exact
 * bytes it will write on approval — not the note as it stands now. That is the
 * whole point: the human approves what is on this card, and editing the note
 * afterwards cannot change what lands in the wiki.
 *
 * The snapshot is shown verbatim in a <pre>, as text. Bot prose is untrusted
 * input; it is displayed, never interpreted.
 */
function PendingPromotionReview({
  agentSlug,
  requestId,
}: {
  agentSlug: string;
  requestId: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const pending = useQuery({
    queryKey: ["knowledge-promotion", requestId],
    queryFn: () => getPendingPromotion(requestId),
    enabled: requestId !== "",
  });

  const answer = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      answerPromotionRequest(requestId, decision),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: ["bot-knowledge", agentSlug],
      });
    },
    onError: (err: unknown) => {
      setError(
        err instanceof Error
          ? err.message
          : "Could not record that decision right now.",
      );
    },
  });

  const snapshot = pending.data;
  return (
    <div className="bot-knowledge-promote">
      <p className="bot-knowledge-promote-note">
        @{agentSlug} asked you to put this in the team wiki
        {snapshot?.reason ? `: ${snapshot.reason}` : "."} Approving publishes
        exactly the text below, plus a footer saying it came from @{agentSlug}.
        Anything the note says after this card was raised is not part of it.
      </p>
      {snapshot ? (
        <>
          <p className="bot-knowledge-promote-note">
            Creates <code>{snapshot.targetPath}</code> · sha256{" "}
            <code>{snapshot.contentSha.slice(0, 16)}</code>
          </p>
          <pre className="bot-knowledge-snapshot">{snapshot.content}</pre>
        </>
      ) : (
        <p className="bot-knowledge-promote-note">
          Loading the page this request would publish…
        </p>
      )}
      {error ? <p className="bot-knowledge-error">{error}</p> : null}
      <button
        type="button"
        className="bot-knowledge-btn"
        disabled={!snapshot || answer.isPending}
        onClick={() => answer.mutate("approve")}
      >
        Approve this promotion
      </button>
      <button
        type="button"
        className="bot-knowledge-btn"
        disabled={!snapshot || answer.isPending}
        onClick={() => answer.mutate("reject")}
      >
        Keep it private
      </button>
    </div>
  );
}

/**
 * The promotion control under an open page. It is a human action end to end:
 * the click carries the content hash the panel displayed, so the broker
 * promotes the bytes that were actually read, or refuses.
 */
function PromoteControl({
  agentSlug,
  page,
  wikiWritable,
}: {
  agentSlug: string;
  page: BotKnowledgePage;
  wikiWritable: boolean;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { promotion, sourcePath } = page;

  const promote = useMutation({
    mutationFn: () => {
      if (!(sourcePath && promotion)) {
        throw new Error(
          "This page has no source note, so it cannot be shared.",
        );
      }
      return promoteBotKnowledge({
        agentSlug,
        sourcePath,
        contentSha: promotion.contentSha,
      });
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: ["bot-knowledge", agentSlug],
      });
    },
    onError: (err: unknown) => {
      setError(
        err instanceof Error
          ? err.message
          : "Could not promote this page right now.",
      );
    },
  });

  if (!promotion) return null;

  if (promotion.state === "promoted") {
    return (
      <div className="bot-knowledge-promote">
        <p className="bot-knowledge-promote-note">
          In the team wiki at <code>{promotion.wikiPath}</code>. Everyone reads
          it there; @{agentSlug} still keeps the note.
        </p>
      </div>
    );
  }

  if (promotion.state === "pending") {
    return (
      <PendingPromotionReview
        agentSlug={agentSlug}
        requestId={promotion.requestId ?? ""}
      />
    );
  }

  return (
    <div className="bot-knowledge-promote">
      <p className="bot-knowledge-promote-note">
        Only @{agentSlug} uses this today. Promoting it copies exactly what you
        are reading into the team wiki, with a note saying it came from @
        {agentSlug}.
      </p>
      {error ? <p className="bot-knowledge-error">{error}</p> : null}
      <button
        type="button"
        className="bot-knowledge-btn"
        disabled={!wikiWritable || promote.isPending}
        onClick={() => promote.mutate()}
      >
        {promote.isPending ? "Promoting…" : "Promote to team wiki"}
      </button>
      {!wikiWritable ? (
        <p className="bot-knowledge-promote-note">
          The wiki is not running right now, so nothing can be promoted yet.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One open page. Sections and paragraphs get stable keys assigned once per page
 * rather than at render, so a re-render never re-keys prose by position.
 */
function KnowledgeArticle({
  agentSlug,
  page,
  wikiWritable,
}: {
  agentSlug: string;
  page: BotKnowledgePage;
  wikiWritable: boolean;
}) {
  const sections = useMemo(
    () =>
      page.sections.map((section, si) => ({
        key: `${page.id}-s${si}`,
        heading: section.heading,
        paras: section.paras.map((text, pi) => ({
          key: `${page.id}-s${si}p${pi}`,
          text,
        })),
      })),
    [page],
  );

  return (
    <article className="bot-knowledge-article">
      <h1>{page.title}</h1>
      <div className="bot-knowledge-meta">
        @{page.agent ?? agentSlug} · {page.sourcePath}
      </div>
      {page.lead ? <p>{page.lead}</p> : null}
      {sections.map((section) => (
        <section key={section.key}>
          {section.heading ? <h2>{section.heading}</h2> : null}
          {section.paras.map((para) => (
            <p key={para.key}>{para.text}</p>
          ))}
        </section>
      ))}
      <PromoteControl
        agentSlug={agentSlug}
        page={page}
        wikiWritable={wikiWritable}
      />
    </article>
  );
}

export function BotKnowledgePanel({ agentSlug }: BotKnowledgePanelProps) {
  const query = useQuery({
    queryKey: ["bot-knowledge", agentSlug],
    queryFn: () => getBotKnowledge(agentSlug),
    staleTime: 60_000,
  });

  const pages = query.data?.pages ?? [];
  // The selection is scoped to the bot it was made in, so switching bots
  // never leaves the reader pinned to a page belonging to someone else. Keeping
  // the slug in state (rather than resetting it in an effect) means there is no
  // frame where the wrong page is on screen.
  const [selection, setSelection] = useState({ agent: agentSlug, id: "" });
  const activeId = selection.agent === agentSlug ? selection.id : "";
  const page = pages.find((p) => p.id === activeId) ?? pages[0];

  if (query.isLoading) {
    return (
      <div className="bot-knowledge">
        <div className="bot-knowledge-empty" role="status">
          <p className="bot-knowledge-empty-title">
            Reading what @{agentSlug} knows…
          </p>
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="bot-knowledge">
        <div className="bot-knowledge-empty">
          <p className="bot-knowledge-empty-title">
            Could not read @{agentSlug}'s knowledge.
          </p>
          <p className="bot-knowledge-empty-hint">
            The broker did not answer. Reopen this tab to try again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bot-knowledge">
      <div className="bot-knowledge-intro">
        <span className="bot-knowledge-eyebrow">Knowledge</span>
        <p className="bot-knowledge-lede">
          What @{agentSlug} knows. Every page names the note it came from. A
          page stays with this agent until you promote it into the team wiki.
        </p>
      </div>

      {pages.length === 0 || !page ? (
        <div className="bot-knowledge-empty">
          <p className="bot-knowledge-empty-title">
            @{agentSlug} has not written anything down yet.
          </p>
          <p className="bot-knowledge-empty-hint">
            Pages appear here as this agent records what it learns. Nothing is
            filled in on its behalf.
          </p>
        </div>
      ) : (
        <div className="bot-knowledge-body">
          <nav
            className="bot-knowledge-list"
            aria-label={`Pages @${agentSlug} knows`}
          >
            {pages.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`bot-knowledge-item${p.id === page.id ? " is-active" : ""}`}
                aria-current={p.id === page.id}
                onClick={() => setSelection({ agent: agentSlug, id: p.id })}
              >
                <span className="bot-knowledge-item-title">{p.title}</span>
                <PromotionPill state={p.promotion?.state ?? "private"} />
              </button>
            ))}
          </nav>

          <KnowledgeArticle
            agentSlug={agentSlug}
            page={page}
            wikiWritable={query.data?.wikiWritable ?? false}
          />
        </div>
      )}
    </div>
  );
}

export default BotKnowledgePanel;
