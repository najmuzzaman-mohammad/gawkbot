/**
 * Markdown pipeline for chat-bubble bot messages.
 *
 * Mirrors the wiki pipeline (wikiMarkdownConfig.tsx) but with a chat-tuned
 * plugin set and CSS class mapping that preserves the legacy formatTrusted
 * visual: msg-h{1,2,3}, msg-codeblock, msg-blockquote, msg-link, msg-ul/ol.
 *
 * SECURITY: This replaces the legacy regex-based formatMarkdown that built
 * its own HTML strings and sent them through dangerouslySetInnerHTML. That
 * path was vulnerable to XSS via markdown links with javascript:/data:
 * URIs because escapeHtml only neutralises < > " &, leaving the URL scheme
 * untouched. ReactMarkdown's default urlTransform strips javascript:,
 * vbscript:, and most data: URIs; we add a belt-and-suspenders allowlist
 * inside the anchor renderer below.
 *
 * @mentions:
 *   Mentions are mapped to mdast link nodes with a fragment URL ("#") and a
 *   `data-wuphf-mention="true"` hProperty as the discriminator. The anchor
 *   renderer detects that data attribute and emits a styled
 *   <span class="mention"> chip — never an <a> with a clickable href.
 *   (Note: an earlier draft used a `wuphf-mention:` URL scheme, but
 *   ReactMarkdown's defaultUrlTransform stripped it as an unknown scheme,
 *   so the chip never rendered. The data-attribute pattern mirrors how
 *   wikiLinkRemarkPlugin tags wikilinks via `data-wikilink`.)
 */

import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

import { AppRefLink } from "./AppRefLink";
import { TaskRefLink } from "./TaskRefLink";

// Mirrors the broker-side mention pattern in internal/team/broker.go.
// Keep in sync with web/src/lib/mentions.tsx.
const MENTION_RE = /(?:^|[^a-zA-Z0-9_])@([a-z0-9][a-z0-9-]{1,29})\b/g;

// Task references in prose ("DUNDE-72", "task-14") become buttons that open
// the shared task modal, so a message about a task is one click from the task
// itself instead of an id the reader has to go hunt for. Matches the two id
// shapes the broker mints: a company-derived prefix (NEX-1, DUNDE-72) and the
// legacy task-N form.
//
// CASE-SENSITIVE, deliberately. The pattern used to carry the /i flag, which
// made the uppercase-prefix branch match ordinary lowercase prose: "request-75"
// in a sentence was linkified as a task and clicked through to nothing. The
// broker only ever mints UPPERCASE prefixes and the lowercase literal "task-",
// so dropping /i is the whole fix — each branch now spells its own case.
const TASK_REF_RE =
  /(?:^|[^A-Za-z0-9_/-])((?:[A-Z][A-Z0-9]{1,11}-\d+|task-\d+))\b/g;

// App references. Bot-built apps carry an `app_<hex>` id, and bots quote
// them in prose ("shipped it in app_9f3c1d2e"). Bare, that is unreadable and
// unclickable; AppRefLink resolves it to the app's name and opens it.
// Mirrors TASK_REF_RE's boundary handling so an id inside a path or an
// existing link is left alone.
const APP_REF_RE = /(?:^|[^A-Za-z0-9_/-])(app_[0-9a-fA-F]{4,32})\b/g;

// Defense-in-depth allowlist applied to anchor href values. ReactMarkdown's
// defaultUrlTransform already strips javascript:, vbscript:, and data:
// (except safe image variants); this re-checks because url handling is too
// important to depend on a single layer.
//
// `\/(?!\/)` rejects protocol-relative URLs (`//evil.com`) while still
// allowing genuine same-origin paths (`/wiki/team/launch`). ReactMarkdown's
// defaultUrlTransform passes `//host/...` through as-is, so the allowlist
// has to do the work.
const SAFE_URL_RE = /^(https?:|mailto:|tel:|\/(?!\/)|#|\.\.?\/|\?)/i;

// ── AST types (minimal mdast surface for the remark plugin) ──

interface MdTextNode {
  type: "text";
  value: string;
}

interface MdLinkNode {
  type: "link";
  url: string;
  children: MdAnyNode[];
  data?: { hProperties?: Record<string, string> };
}

type MdAnyNode =
  | MdTextNode
  | MdLinkNode
  | { type: string; children?: MdAnyNode[]; value?: string };

interface MdParent {
  children: MdAnyNode[];
}

/**
 * Remark plugin that rewrites `@slug` substrings inside text nodes into
 * link nodes carrying a `data-wuphf-mention="true"` hProperty (the URL is
 * a no-op `#` fragment). The renderer below converts those into mention
 * chips. Following the wikiLinkRemarkPlugin pattern.
 */
export function mentionRemarkPlugin() {
  return function plugin() {
    return function transformer(tree: unknown) {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cognitive complexity is baselined for a focused follow-up refactor.
      walk(tree as MdAnyNode, (parent) => {
        const { children } = parent;
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (
            child.type !== "text" ||
            typeof (child as MdTextNode).value !== "string"
          )
            continue;
          const { value } = child as MdTextNode;
          const hasMention = value.includes("@");
          const hasTaskRef = /[A-Za-z]-?\d/.test(value);
          if (!(hasMention || hasTaskRef)) continue;

          const replacements = buildInlineReplacements(value);
          if (replacements.length === 0) continue;
          children.splice(i, 1, ...replacements);
          i += replacements.length - 1;
        }
      });
    };
  };
}

// buildInlineReplacements runs the mention pass, then linkifies task ids in
// whatever plain text is left. Order matters: a mention chip must never be
// re-scanned as a task ref, and a task ref inside an existing link is skipped
// because only `text` nodes reach this function.
function buildInlineReplacements(value: string): MdAnyNode[] {
  const mentionParts = buildMentionReplacements(value);
  const parts =
    mentionParts.length > 0
      ? mentionParts
      : [{ type: "text", value } as MdAnyNode];
  const out: MdAnyNode[] = [];
  let linkified = false;
  for (const part of parts) {
    if (
      part.type !== "text" ||
      typeof (part as MdTextNode).value !== "string"
    ) {
      out.push(part);
      continue;
    }
    const taskParts = buildTaskRefReplacements((part as MdTextNode).value);
    if (taskParts.length > 0) {
      linkified = true;
      // An app id can sit in the text either side of a task ref, so the app
      // pass runs over whatever text the task pass left behind rather than
      // over the original string.
      for (const tp of taskParts) {
        if (tp.type !== "text") {
          out.push(tp);
          continue;
        }
        const appParts = buildAppRefReplacements((tp as MdTextNode).value);
        if (appParts.length === 0) out.push(tp);
        else out.push(...appParts);
      }
      continue;
    }
    const appOnly = buildAppRefReplacements((part as MdTextNode).value);
    if (appOnly.length === 0) {
      out.push(part);
      continue;
    }
    linkified = true;
    out.push(...appOnly);
  }
  if (mentionParts.length === 0 && !linkified) return [];
  return out;
}

function buildAppRefReplacements(value: string): MdAnyNode[] {
  const matches = [...value.matchAll(APP_REF_RE)];
  if (matches.length === 0) return [];
  const out: MdAnyNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    const id = m[1];
    if (!id) continue;
    const start = value.indexOf(id, m.index ?? 0);
    if (start === -1) continue;
    if (start > cursor)
      out.push({ type: "text", value: value.slice(cursor, start) });
    out.push({
      type: "link",
      url: "#",
      children: [{ type: "text", value: id }],
      data: { hProperties: { "data-wuphf-app": "true", "data-app-id": id } },
    });
    cursor = start + id.length;
  }
  if (cursor === 0) return [];
  if (cursor < value.length)
    out.push({ type: "text", value: value.slice(cursor) });
  return out;
}

function buildTaskRefReplacements(value: string): MdAnyNode[] {
  const matches = [...value.matchAll(TASK_REF_RE)];
  if (matches.length === 0) return [];
  const out: MdAnyNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    const id = m[1];
    if (!id) continue;
    const start = value.indexOf(id, m.index ?? 0);
    if (start === -1) continue;
    if (start > cursor)
      out.push({ type: "text", value: value.slice(cursor, start) });
    out.push({
      type: "link",
      url: "#",
      children: [{ type: "text", value: id }],
      data: { hProperties: { "data-wuphf-task": "true", "data-task-id": id } },
    });
    cursor = start + id.length;
  }
  if (cursor === 0) return [];
  if (cursor < value.length)
    out.push({ type: "text", value: value.slice(cursor) });
  return out;
}

function buildMentionReplacements(value: string): MdAnyNode[] {
  // Use matchAll so we don't have to manage a stateful lastIndex on a /g regex.
  const matches = [...value.matchAll(MENTION_RE)];
  if (matches.length === 0) return [];
  const out: MdAnyNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    const [, slug] = m;
    if (!slug) continue;
    // The regex captures one optional prefix char (boundary). Find the actual
    // '@' position so we slice the surrounding text correctly.
    const matchStart = m.index ?? 0;
    const atIndex = value.indexOf(`@${slug}`, matchStart);
    if (atIndex === -1) continue;
    if (atIndex > cursor) {
      out.push({ type: "text", value: value.slice(cursor, atIndex) });
    }
    // Use a safe, no-op fragment URL and a data attribute as the discriminator.
    // ReactMarkdown's defaultUrlTransform passes through #-only URLs, and the
    // anchor renderer below checks data-wuphf-mention to swap to a chip.
    out.push({
      type: "link",
      url: "#",
      children: [{ type: "text", value: `@${slug}` }],
      data: {
        hProperties: {
          "data-wuphf-mention": "true",
          "data-slug": slug,
        },
      },
    });
    cursor = atIndex + slug.length + 1; // +1 for the @
  }
  if (cursor === 0) return [];
  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) });
  }
  return out;
}

function walk(node: MdAnyNode, onParent: (parent: MdParent) => void) {
  const maybeParent = node as { children?: MdAnyNode[]; type?: string };
  const { children } = maybeParent;
  if (!Array.isArray(children)) return;
  // Don't transform text inside link nodes:
  //  - the user wrote link text deliberately; chipping @slug there would surprise them
  //  - more importantly, we'd recurse into the synthetic mention links we
  //    just inserted (whose text is "@slug"), causing infinite recursion.
  if (maybeParent.type === "link") return;
  onParent(node as MdParent);
  const snapshot = [...(maybeParent.children || [])];
  for (const child of snapshot) {
    if (child && typeof child === "object" && "children" in child) {
      walk(child as MdAnyNode, onParent);
    }
  }
}

// ── Plugin lists ──

/** Remark plugins for chat messages: GFM autolinks/strikethrough + @-mentions. */
export const messageRemarkPlugins: PluggableList = [
  remarkGfm,
  mentionRemarkPlugin(),
];

// ── Component overrides ──

type AnchorProps = ComponentProps<"a">;

/**
 * Returns true if the URL is safe to put in an <a href>. ReactMarkdown's
 * defaultUrlTransform already strips javascript:/vbscript:/most-data: schemes;
 * this is the second layer.
 */
function isSafeHref(href: string | undefined): boolean {
  if (!href) return false;
  return SAFE_URL_RE.test(href.trim());
}

/**
 * Component overrides that preserve the legacy chat-bubble visual classes.
 * Block-level elements use <div> with msg-* classes (the legacy rendering)
 * rather than browser-default <h1>/<blockquote>/etc., so existing CSS in
 * web/src/styles/messages.css continues to apply unchanged.
 */
export const messageMarkdownComponents: Partial<Components> = {
  a: (props: AnchorProps): ReactElement => {
    // ReactMarkdown v10 augments component props with ExtraProps, which
    // includes a `node` (hast Element). Pull it out before spreading so it
    // never lands on the DOM <a> element (would trigger an "unrecognized
    // prop on DOM element" warning in dev).
    const {
      href,
      children,
      node: _node,
      ...rest
    } = props as AnchorProps & { node?: unknown };
    const record = rest as Record<string, unknown>;
    if (record["data-wuphf-mention"] === "true") {
      // Mention chip — never a navigable link.
      return <span className="mention">{children}</span>;
    }
    if (record["data-wuphf-app"] === "true") {
      // App reference — a pill that opens the app.
      const appId = String(record["data-app-id"] ?? "").trim();
      return <AppRefLink appId={appId}>{children}</AppRefLink>;
    }
    if (record["data-wuphf-task"] === "true") {
      // Task reference — opens the shared task modal in place. It must NOT
      // navigate: /tasks/$taskId is a chat-primary surface, and a task is no
      // longer a doorway to a room.
      const taskId = String(record["data-task-id"] ?? "").trim();
      return <TaskRefLink taskId={taskId}>{children}</TaskRefLink>;
    }
    const safe = isSafeHref(href) ? href : undefined;
    // Only external schemes pop a new tab. Fragment links (`#section`) and
    // same-origin relative paths (`/wiki/...`) navigate in-place so
    // anchor-to-section scrolling and TanStack-Router transitions still work.
    const isExternal = !!safe && /^(https?:|mailto:|tel:)/i.test(safe);
    return (
      <a
        {...rest}
        href={safe}
        className="msg-link"
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },

  h1: ({ children }): ReactElement => (
    <div className="msg-h1">{children as ReactNode}</div>
  ),
  h2: ({ children }): ReactElement => (
    <div className="msg-h2">{children as ReactNode}</div>
  ),
  h3: ({ children }): ReactElement => (
    <div className="msg-h3">{children as ReactNode}</div>
  ),
  h4: ({ children }): ReactElement => (
    <div className="msg-h3">{children as ReactNode}</div>
  ),
  h5: ({ children }): ReactElement => (
    <div className="msg-h3">{children as ReactNode}</div>
  ),
  h6: ({ children }): ReactElement => (
    <div className="msg-h3">{children as ReactNode}</div>
  ),

  blockquote: ({ children }): ReactElement => (
    <div className="msg-blockquote">{children as ReactNode}</div>
  ),

  hr: (): ReactElement => <hr className="msg-hr" />,

  ul: ({ children }): ReactElement => (
    <ul className="msg-ul">{children as ReactNode}</ul>
  ),
  ol: ({ children }): ReactElement => (
    <ol className="msg-ol">{children as ReactNode}</ol>
  ),

  pre: ({ children }): ReactElement => (
    <div className="msg-codeblock">{children as ReactNode}</div>
  ),

  // Inline code stays as <code> (default rendering is fine — fenced blocks
  // get the .msg-codeblock wrapper from the pre override above).

  // Paragraphs in the chat bubble historically rendered as <span>+<br/> to
  // preserve inline flow inside the bubble. ReactMarkdown wraps in <p> by
  // default; we override to keep the legacy DOM shape.
  p: ({ children }): ReactElement => (
    <span>
      {children as ReactNode}
      <br />
    </span>
  ),
};
