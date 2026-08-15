// Knowledge — a Wikipedia-style reader over the company brain (gbrain). Every
// claim that came from somewhere carries a citation. Hovering (or focusing) a
// citation shows the source: what kind it is, where it came from, and the exact
// snippet the fact was drawn from. An "Explain" button reveals why the brain
// chose that source for this fact (e.g. why a specific chat backs an insight).
//
// With an `appId` this reads the app's REAL synthesized pages from the broker
// (grounded in the app's own artifacts, cached). Without one it renders the mock
// pages — the shape is identical, so the render code is shared verbatim.

import { type ReactNode, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { getBlob } from "../../api/client";
import {
  getAppKnowledge,
  getKnowledgeArtifactHTML,
} from "../apps/knowledgeClient";
import { EmptyState } from "../components/EmptyState";
import { Eyebrow } from "../components/primitives";
import {
  KNOWLEDGE,
  type KnowledgeArtifact,
  type KnowledgePage,
  type KnowledgeRef,
  type KnowledgeSourceKind,
} from "../mock/data";

const KIND_LABEL: Record<KnowledgeSourceKind, string> = {
  chat: "Chat",
  document: "Document",
  crm: "CRM",
  decision: "Decision",
  roster: "Roster",
};

// Jump to a reference list item without mutating the URL hash. Writing
// `#ref-n` into window.location.hash would replace the /#/operator route and
// unmount the hash-routed shell, so we scroll to the target imperatively.
function jumpToRef(n: number) {
  document.getElementById(`ref-${n}`)?.scrollIntoView({ block: "start" });
}

// ── Page artifacts: preserved file-ish views (legacy HTML briefs / PDFs) ──────

// One attached artifact. HTML opens inline in a FULLY sandboxed iframe (the
// content is fetched through the authed client and rendered via srcDoc — no
// scripts, no navigation, no same-origin); a PDF downloads through the authed
// client (a plain <a href> cannot carry the auth header).
function ArtifactItem({ artifact }: { artifact: KnowledgeArtifact }) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function view() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (artifact.kind === "html" && html === null) {
      try {
        setHtml(await getKnowledgeArtifactHTML(artifact.url));
      } catch {
        setFailed(true);
      }
    }
  }

  async function download() {
    try {
      const blob = await getBlob(artifact.url);
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `${artifact.title}.pdf`;
      a.click();
      URL.revokeObjectURL(href);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="opr-page-artifact">
      <button
        type="button"
        className="opr-btn opr-btn-sm"
        onClick={() => void (artifact.kind === "pdf" ? download() : view())}
      >
        <span className={`opr-artifact-badge is-${artifact.kind}`}>
          {artifact.kind.toUpperCase()}
        </span>
        {artifact.title}
        {artifact.kind === "html" ? (open ? " · hide" : " · view") : ""}
      </button>
      {failed ? (
        <p className="opr-scoped-note">
          Could not load this artifact right now.
        </p>
      ) : null}
      {open && artifact.kind === "html" ? (
        html === null ? (
          <p className="opr-scoped-note">Loading…</p>
        ) : (
          // The EMPTY sandbox attribute is the security boundary for preserved
          // HTML: no scripts, no navigation, no same-origin. Never loosen it.
          <iframe
            className="opr-artifact-html"
            title={artifact.title}
            sandbox=""
            srcDoc={html}
          />
        )
      ) : null}
    </div>
  );
}

// A single [n] citation with a hover/focus popover over its source.
function Citation({ n, source }: { n: number; source?: KnowledgeRef }) {
  const [explained, setExplained] = useState(false);

  if (!source) {
    return (
      <sup className="opr-cite">
        <button
          type="button"
          onClick={() => jumpToRef(n)}
          aria-label={`Jump to reference ${n}`}
        >
          [{n}]
        </button>
      </sup>
    );
  }

  return (
    <sup className="opr-cite opr-cite-has-pop">
      <button
        type="button"
        onClick={() => jumpToRef(n)}
        aria-label={`Source ${n}: ${source.title}`}
      >
        [{n}]
      </button>
      <span className="opr-cite-pop" role="note">
        <span className="opr-cite-pop-head">
          <span className="opr-cite-pop-kind">{KIND_LABEL[source.kind]}</span>
          <span className="opr-cite-pop-title">{source.title}</span>
        </span>
        <span className="opr-cite-pop-detail">{source.detail}</span>
        <span className="opr-cite-pop-snippet">{source.snippet}</span>
        {explained ? (
          <span className="opr-cite-pop-why">
            <span className="opr-cite-pop-why-label">
              <Sparkles size={11} strokeWidth={2} aria-hidden={true} /> Why this
              source
            </span>
            {source.why}
          </span>
        ) : (
          <button
            type="button"
            className="opr-btn opr-btn-sm opr-cite-pop-explain"
            onClick={() => setExplained(true)}
          >
            <Sparkles size={12} strokeWidth={2} aria-hidden={true} />
            Explain
          </button>
        )}
      </span>
    </sup>
  );
}

// A reference at the bottom of a page. Clickable: opening it reveals the source
// itself — the exact excerpt the fact was drawn from, and why the brain chose
// it. So every reference is reachable, not just a label.
function ReferenceItem({ source }: { source: KnowledgeRef }) {
  const [open, setOpen] = useState(false);
  return (
    <li id={`ref-${source.n}`} className="opr-ref-item">
      <button
        type="button"
        className="opr-ref-row"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="opr-ref-kind">{KIND_LABEL[source.kind]}</span>
        <span className="opr-ref-source">{source.title}</span>
        <span className="opr-ref-detail"> · {source.detail}</span>
      </button>
      {open ? (
        <div className="opr-ref-expand">
          <p className="opr-ref-snippet">{source.snippet}</p>
          <p className="opr-ref-why">
            <span className="opr-ref-why-label">
              <Sparkles size={11} strokeWidth={2} aria-hidden={true} /> Why this
              source
            </span>
            {source.why}
          </p>
        </div>
      ) : null}
    </li>
  );
}

// Turn "...routes it.[[1]]" prose into text + citation popovers.
function renderProse(
  text: string,
  refByN: Map<number, KnowledgeRef>,
): ReactNode[] {
  return text.split(/(\[\[\d+\]\])/g).map((part, i) => {
    const m = part.match(/^\[\[(\d+)\]\]$/);
    if (m) {
      const n = Number(m[1]);
      return <Citation key={i} n={n} source={refByN.get(n)} />;
    }
    return <span key={i}>{part}</span>;
  });
}

interface KnowledgeSurfaceProps {
  /**
   * When set, read the app's REAL synthesized knowledge from the broker. When
   * absent, render the mock pages (same shape, same render).
   */
  appId?: string;
}

export function KnowledgeSurface({ appId }: KnowledgeSurfaceProps) {
  const query = useQuery({
    queryKey: ["operator-app-knowledge", appId],
    queryFn: () => getAppKnowledge(appId ?? ""),
    enabled: Boolean(appId),
    staleTime: 5 * 60_000,
    // A first synthesis is slow (getAppKnowledge waits patiently for it) but can
    // still miss — a transient blip, or the very first read losing the race to
    // warm the cache. Keep polling while there are no pages AND the broker has
    // returned no real verdict; the synthesis warms the cache server-side, so a
    // later poll lands on ready pages. Stop once pages arrive or the broker
    // reports a real provider/rate-limit verdict (data.error). This is the
    // "keep working" backstop; automatic retry is inherited from the client.
    refetchInterval: (q) => {
      if (!appId) return false;
      const data = q.state.data;
      if (data?.pages?.length) return false;
      if (data?.error) return false;
      return q.state.status === "error" ? 6_000 : false;
    },
  });

  const pages: KnowledgePage[] = appId ? (query.data?.pages ?? []) : KNOWLEDGE;
  const [activeId, setActiveId] = useState("");
  const page = pages.find((k) => k.id === activeId) ?? pages[0];
  const titleOf = (id: string) => pages.find((k) => k.id === id)?.title ?? id;

  const refByN = useMemo(
    () => new Map((page?.references ?? []).map((r) => [r.n, r])),
    [page],
  );

  // A first synthesis is slow (up to ~90s server-side, cached after). While the
  // query is loading OR re-fetching a slow/failed attempt with nothing to show
  // yet, we are still working — never flip to an error mid-flight.
  const working =
    Boolean(appId) &&
    pages.length === 0 &&
    (query.isLoading || query.isFetching);

  // Error taxonomy. A REAL provider verdict comes back in the RESPONSE BODY
  // ({ error: "ai_unavailable" | "rate_limited" }) with HTTP 200 — that is the
  // ONLY signal that the AI provider is down or throttled. A timeout, abort, or
  // transport failure is query.isError with NO body: that means "the synthesis
  // did not finish in time", which is a "still working" state, never a provider
  // verdict. Keeping the two apart is the fix for a slow first synthesis being
  // mislabeled "your AI provider is not reachable".
  const backendError = appId ? query.data?.error : undefined;
  const providerUnavailable =
    Boolean(appId) && pages.length === 0 && backendError === "ai_unavailable";
  const rateLimited =
    Boolean(appId) && pages.length === 0 && backendError === "rate_limited";
  const stillWorking =
    Boolean(appId) &&
    !working &&
    pages.length === 0 &&
    !backendError &&
    query.isError;
  const emptyBrain =
    Boolean(appId) &&
    !working &&
    !stillWorking &&
    !providerUnavailable &&
    !rateLimited &&
    pages.length === 0;

  return (
    <div className="opr-surface-wide">
      {appId ? (
        // Per-agent tab: the agent's own header is already above — a compact
        // intro, not a second page-scale hero, and per-agent truth (the data
        // here is fetched by appId, not a shared brain).
        <div className="opr-data-intro">
          <Eyebrow>Knowledge</Eyebrow>
          <p className="opr-scoped-note">
            What this agent knows, each fact cited to its source. Hover a
            citation to see where it came from.
          </p>
        </div>
      ) : (
        <div
          className="opr-surface-head"
          style={{ marginBottom: "var(--space-4)" }}
        >
          <div>
            <Eyebrow>Knowledge</Eyebrow>
            <h1 className="opr-surface-title">What your AI knows</h1>
            <p className="opr-surface-lede">
              Everything your agents have learned, each fact cited back to where
              it came from, so you can trust what they act on. Hover a citation
              to see the source, and ask why it was chosen.
            </p>
          </div>
          <button type="button" className="opr-btn opr-btn-sm">
            New page
          </button>
        </div>
      )}

      {working || stillWorking ? (
        <div className="opr-app-building" role="status">
          <span className="opr-work-dots" aria-hidden={true}>
            <span />
            <span />
            <span />
          </span>
          <div className="opr-empty-title">
            {stillWorking
              ? "Still reading what your AI knows…"
              : "Reading what your AI knows…"}
          </div>
          <div className="opr-empty-hint">
            {stillWorking
              ? "This is taking longer than usual. Hang tight — it keeps trying, and the cited pages appear the moment they are ready."
              : "Synthesizing cited pages from everything your AI has learned."}
          </div>
        </div>
      ) : rateLimited ? (
        <EmptyState
          glyph="⚠"
          title="Knowledge is busy — try again in a minute."
          hint="Your AI hit a rate limit while synthesizing these pages. Nothing is lost — reopen this tab shortly."
        />
      ) : providerUnavailable ? (
        <EmptyState
          glyph="⚠"
          title="Knowledge is unavailable right now."
          hint="Your AI provider is not reachable or not configured, so cited pages could not be synthesized. Once it is back, they appear here."
        />
      ) : emptyBrain ? (
        <EmptyState
          glyph="📖"
          title="No knowledge yet"
          hint="Your AI has not written any cited pages yet. As it learns from your workspace, they appear here."
        />
      ) : (
        <div className="opr-wiki">
          <nav className="opr-kn-list" aria-label="Knowledge pages">
            <div
              className="opr-eyebrow"
              style={{ marginBottom: "var(--space-2)" }}
            >
              Pages
            </div>
            {pages.map((k) => (
              <button
                key={k.id}
                type="button"
                className={`opr-kn-item${k.id === (page?.id ?? "") ? " is-active" : ""}`}
                onClick={() => setActiveId(k.id)}
              >
                {k.title}
              </button>
            ))}
          </nav>

          {page ? (
            <article className="opr-article">
              <aside className="opr-article-infobox">
                <div className="opr-infobox-title">{page.title}</div>
                <dl>
                  {page.infobox.map((row) => (
                    <div className="opr-infobox-row" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{renderProse(row.value, refByN)}</dd>
                    </div>
                  ))}
                </dl>
              </aside>

              <h1>{page.title}</h1>
              <div className="opr-article-meta">
                From the company brain · {page.updatedAt}
              </div>
              {page.alsoIn && page.alsoIn.length > 0 ? (
                <div className="opr-article-alsoin">
                  Also used by{" "}
                  {page.alsoIn.map((a, i) => (
                    <span key={a.appId}>
                      {i > 0 ? ", " : ""}
                      <span className="opr-alsoin-app">{a.name}</span>
                    </span>
                  ))}
                </div>
              ) : null}

              <p className="opr-article-lead">
                {renderProse(page.lead, refByN)}
              </p>

              {page.sections.map((section) => (
                <section key={section.heading ?? "body"}>
                  {section.heading ? <h2>{section.heading}</h2> : null}
                  {section.paras.map((para, i) => (
                    <p key={i}>{renderProse(para, refByN)}</p>
                  ))}
                </section>
              ))}

              {page.artifacts && page.artifacts.length > 0 ? (
                <>
                  <h2>Artifacts</h2>
                  {page.artifacts.map((artifact) => (
                    <ArtifactItem
                      key={`${page.id}-${artifact.url}`}
                      artifact={artifact}
                    />
                  ))}
                </>
              ) : null}

              {page.references.length > 0 ? (
                <>
                  <h2>References</h2>
                  <ol className="opr-refs">
                    {page.references.map((ref) => (
                      // Key by page identity + n: ref numbers reset per page,
                      // so a bare ref.n would reuse instances (and leak open
                      // state) across page switches.
                      <ReferenceItem key={`${page.id}-${ref.n}`} source={ref} />
                    ))}
                  </ol>
                </>
              ) : null}

              {page.seeAlso.length > 0 ? (
                <>
                  <h2>See also</h2>
                  <ul className="opr-seealso">
                    {page.seeAlso.map((id) => (
                      <li key={id}>
                        <button
                          type="button"
                          className="opr-wikilink"
                          onClick={() => setActiveId(id)}
                        >
                          {titleOf(id)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </article>
          ) : null}
        </div>
      )}
    </div>
  );
}
