import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { NOTCH_QUERY_KEY } from "./api";
import { clockLabel } from "./home/model";
import { acceptIdea, dismissIdea, markIdeaSeen, scanIdeas } from "./ideasApi";
import { NotchBot } from "./NotchBot";
import type { NotchIdea, NotchIdeas as NotchIdeasData } from "./types";

export interface NotchIdeasProps {
  ideas: NotchIdeasData;
  /** Opens the full view at a path: the new bot's page after a Yes. */
  onOpen: (path: string) => void;
}

/** "Want to bring me on as your release checker?" */
export function bringOnLine(idea: Pick<NotchIdea, "role" | "name">): string {
  // A role is a job title ("release checker"); a sentence reads as the name.
  const title = idea.role.trim();
  const role =
    title && title.split(/\s+/).length <= 4 ? title : idea.name.trim();
  return `Want to bring me on as your ${role.toLowerCase()}?`;
}

/**
 * Suggested for you: the office's ideas for new bots, one card at a time.
 * Each is a character, a name, the integration it works through, a promise
 * in its own words citing what it saw, why now, and how often. No sends
 * it away; "Yes, make it and go" creates the bot and starts it.
 */
export function NotchIdeas({ ideas, onOpen }: NotchIdeasProps) {
  const queryClient = useQueryClient();
  const { items } = ideas;
  const [at, setAt] = useState(0);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [made, setMade] = useState<{
    id: string;
    slug: string;
    name: string;
  } | null>(null);
  const [showing, setShowing] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const live = items.filter((i) => !gone.has(i.id));
  const index = Math.min(at, Math.max(0, live.length - 1));
  const idea = live[index];

  useEffect(() => {
    if (!idea || seen.current.has(idea.id)) return;
    seen.current.add(idea.id);
    void markIdeaSeen(idea.id).catch(() => undefined);
  }, [idea]);

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: NOTCH_QUERY_KEY });
  const no = useMutation({
    mutationFn: (id: string) => dismissIdea(id),
    onMutate: (id) => setGone((g) => new Set(g).add(id)),
    onSettled: refresh,
  });
  const scan = useMutation({ mutationFn: scanIdeas, onSettled: refresh });
  const yes = useMutation({
    mutationFn: (id: string) => acceptIdea(id),
    onSuccess: (r, id) => {
      setMade({ id, slug: r.slug, name: idea?.name ?? "" });
      setGone((g) => new Set(g).add(id));
      refresh();
    },
  });

  const checked = clockLabel(ideas.checked_at, Date.now());
  const sub =
    live.length > 0
      ? `${live.length} ${live.length === 1 ? "idea" : "ideas"}, ready when you are.${checked ? ` Last checked ${checked}.` : ""}`
      : ideas.scanning || scan.isPending
        ? "Looking across your apps…"
        : `Nothing new${checked ? ` since ${checked}` : " yet"}. Ideas come from the apps you connected, once a day.`;
  const header = (
    <header className="npane-head">
      <h2>Suggested for you</h2>
      <p>{sub}</p>
      {live.length > 1 && !made ? (
        <span className="nidea-nav">
          <button
            type="button"
            className="nicon"
            aria-label="Previous idea"
            disabled={index === 0}
            onClick={() => setAt(index - 1)}
          >
            ‹
          </button>
          <span>
            {index + 1} of {live.length}
          </span>
          <button
            type="button"
            className="nicon"
            aria-label="Next idea"
            disabled={index >= live.length - 1}
            onClick={() => setAt(index + 1)}
          >
            ›
          </button>
        </span>
      ) : null}
    </header>
  );
  if (made) {
    return (
      <section className="npane nideas" aria-label="Suggested for you">
        {header}
        <div className="nidea-stage">
          <NotchBot slug={made.slug} mood="working" size={64} label="" />
          <div className="nidea nidea-made" data-testid="notch-idea-made">
            <b>{made.name} is on it.</b>
            <p className="nidea-why">
              Its first task is under way. It is in your list now, and its card
              sits at the top right while it works.
            </p>
            <div className="nidea-actions">
              <button
                type="button"
                className="nbtn is-quiet"
                onClick={() =>
                  onOpen(`/agents/${encodeURIComponent(made.slug)}`)
                }
              >
                Open
              </button>
              <button
                type="button"
                className="nbtn is-primary"
                onClick={() => setMade(null)}
              >
                {live.length > 0 ? "Next idea" : "Done"}
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }
  if (!idea) {
    return (
      <section className="npane nideas" aria-label="Suggested for you">
        {header}
        {ideas.enabled ? (
          <div className="nidea-actions is-empty">
            <button
              type="button"
              className="nbtn is-quiet"
              disabled={scan.isPending || ideas.scanning}
              onClick={() => scan.mutate()}
            >
              Look now
            </button>
          </div>
        ) : null}
      </section>
    );
  }
  const busy = yes.isPending || no.isPending;
  return (
    <section className="npane nideas" aria-label="Suggested for you">
      {header}
      <div className="nidea-stage">
        <NotchBot
          slug={idea.id}
          avatar={idea.avatar}
          mood="idle"
          size={64}
          label=""
          badge={false}
        />
        <div className="nidea" data-testid={`notch-idea-${idea.id}`}>
          <div className="nidea-head">
            <span className="nidea-who">
              <b>{idea.name}</b>
              <small>A new bot for this idea</small>
            </span>
            <span className="nidea-badge">
              {idea.logo_url ? (
                <img src={idea.logo_url} alt="" width={14} height={14} />
              ) : null}
              {idea.integration_name}
            </span>
          </div>
          <p className="nidea-promise">{idea.promise}</p>
          {idea.rationale ? (
            <p className="nidea-why">{idea.rationale}</p>
          ) : null}
          {idea.cadence_label ? (
            <p className="nidea-when">{idea.cadence_label}</p>
          ) : null}
          {idea.evidence && idea.evidence.length > 0 ? (
            <div className="nidea-source">
              <button
                type="button"
                className="nidea-source-toggle"
                aria-expanded={showing}
                onClick={() => setShowing(!showing)}
              >
                {showing ? "Hide" : "Show"} what it saw · {idea.evidence.length}
              </button>
              {showing ? (
                <ul>
                  {idea.evidence.map((e) => (
                    <li key={e.id}>{e.text}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <p className="nidea-ask">{bringOnLine(idea)}</p>
      {yes.isError ? (
        <p className="nidea-error">
          Could not make it. Try again, or from the full view.
        </p>
      ) : null}
      <div className="nidea-actions">
        <button
          type="button"
          className="nbtn is-quiet"
          disabled={busy}
          onClick={() => no.mutate(idea.id)}
        >
          No
        </button>
        <button
          type="button"
          className="nbtn is-primary"
          disabled={busy}
          onClick={() => yes.mutate(idea.id)}
        >
          {yes.isPending ? "Making it…" : "Yes, make it and go"}
        </button>
      </div>
    </section>
  );
}
