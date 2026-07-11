import { z } from "zod/v4";

import { get, post } from "./client";

export const OPENUI_ARTIFACT_VERSION = "0.5";
export const OPENUI_ARTIFACT_LIBRARY = "wuphf-static-review";
export const OPENUI_ARTIFACT_LIBRARY_HASH =
  "f1224a608682fd95303ede0e1227a1e17d87bd7d646630081bd42674ffe1ee85";

export type RichArtifactKind =
  | "notebook_html"
  | "notebook_openui"
  | "wiki_visual";
export type RichArtifactTrustLevel = "draft" | "reviewed" | "promoted";

// ArtifactPromotion is the canonical "where does this artifact live now?"
// signal that drives link routing in chat bubbles and embed wiring in the
// wiki detail views. Backend contract (agreed with the Go side):
//
//   { status: "draft" }                                            // unpromoted, only at /articles/$id
//   { status: "promoted_to_notebook", owner_slug, entry_slug }     // legacy wire field (surface retired); resolves to /articles/$id
//   { status: "promoted_to_wiki", wiki_path }                      // promoted into the team wiki
//
// wiki_path is relative to the wiki root, e.g.
// "team/reference/coffee-extraction-science.md".
export type ArtifactPromotion =
  | { status: "draft" }
  | {
      status: "promoted_to_notebook";
      owner_slug: string;
      entry_slug: string;
    }
  | { status: "promoted_to_wiki"; wiki_path: string };

interface RichArtifactBase {
  id: string;
  kind: RichArtifactKind;
  title: string;
  summary: string;
  trustLevel: RichArtifactTrustLevel;
  sourceMarkdownPath?: string;
  promotedWikiPath?: string;
  relatedTaskId?: string;
  relatedMessageId?: string;
  relatedReceiptIds?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  // promotion is the new canonical promotion-state field. It is optional
  // for backward compatibility with older broker responses that have not
  // been re-emitted yet; consumers should fall back to deriving a
  // best-effort state from promotedWikiPath when promotion is absent (see
  // resolveArtifactDestination).
  promotion?: ArtifactPromotion;
  // attached_to_notebook_entry is the artifact's notebook home, set by the
  // broker when the artifact is created against a source_markdown_path that
  // resolves to a known notebook entry. Even draft artifacts get this set,
  // so the chat link card can deep-link the user to the entry page (which
  // embeds the artifact inline via NotebookVisualArtifacts) instead of the
  // standalone /articles/$id viewer.
  attached_to_notebook_entry?: {
    owner_slug: string;
    entry_slug: string;
  } | null;
}

export interface HTMLRichArtifact extends RichArtifactBase {
  representation: "html";
  htmlPath: string;
  contentPath?: never;
  sanitizerVersion: string;
  openuiVersion?: never;
  openuiLibrary?: never;
  openuiLibraryHash?: never;
}

export interface OpenUIRichArtifact extends RichArtifactBase {
  representation: "openui";
  contentPath: string;
  htmlPath?: never;
  sanitizerVersion?: never;
  openuiVersion: typeof OPENUI_ARTIFACT_VERSION;
  openuiLibrary: typeof OPENUI_ARTIFACT_LIBRARY;
  openuiLibraryHash: typeof OPENUI_ARTIFACT_LIBRARY_HASH;
}

export type RichArtifact = HTMLRichArtifact | OpenUIRichArtifact;

export interface HTMLRichArtifactDetail {
  artifact: HTMLRichArtifact;
  html: string;
  openui?: never;
}

export interface OpenUIRichArtifactDetail {
  artifact: OpenUIRichArtifact;
  openui: string;
  html?: never;
}

export type RichArtifactDetail =
  | HTMLRichArtifactDetail
  | OpenUIRichArtifactDetail;

export interface CreateRichArtifactParams {
  slug: string;
  title: string;
  summary?: string;
  openuiLang: string;
  sourceMarkdownPath?: string;
  relatedTaskId?: string;
  relatedMessageId?: string;
  relatedReceiptIds?: string[];
  commitMessage?: string;
}

export interface PromoteRichArtifactParams {
  targetWikiPath: string;
  markdownSummary: string;
  mode?: "create" | "replace" | "append_section";
  commitMessage?: string;
}

const promotionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("draft") }).strict(),
  z
    .object({
      status: z.literal("promoted_to_notebook"),
      owner_slug: z.string(),
      entry_slug: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("promoted_to_wiki"),
      wiki_path: z.string(),
    })
    .strict(),
]);

const artifactBaseSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["notebook_html", "notebook_openui", "wiki_visual"]),
    title: z.string(),
    summary: z.string(),
    trustLevel: z.enum(["draft", "reviewed", "promoted"]),
    sourceMarkdownPath: z.string().optional(),
    promotedWikiPath: z.string().optional(),
    relatedTaskId: z.string().optional(),
    relatedMessageId: z.string().optional(),
    relatedReceiptIds: z.array(z.string()).optional(),
    createdBy: z.string(),
    owner_slug: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    contentHash: z.string(),
    promotion: promotionSchema.optional(),
    attached_to_notebook_entry: z
      .object({ owner_slug: z.string(), entry_slug: z.string() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const htmlArtifactSchema = artifactBaseSchema
  .extend({
    representation: z.literal("html"),
    htmlPath: z.string(),
    contentPath: z.never().optional(),
    sanitizerVersion: z.string(),
    openuiVersion: z.never().optional(),
    openuiLibrary: z.never().optional(),
    openuiLibraryHash: z.never().optional(),
  })
  .strict();

const openUIArtifactSchema = artifactBaseSchema
  .extend({
    representation: z.literal("openui"),
    contentPath: z.string(),
    htmlPath: z.never().optional(),
    sanitizerVersion: z.never().optional(),
    openuiVersion: z.literal(OPENUI_ARTIFACT_VERSION),
    openuiLibrary: z.literal(OPENUI_ARTIFACT_LIBRARY),
    openuiLibraryHash: z.literal(OPENUI_ARTIFACT_LIBRARY_HASH),
  })
  .strict();

const richArtifactSchema = z.preprocess(
  (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      !("representation" in value)
    ) {
      return { ...value, representation: "html" };
    }
    return value;
  },
  z.discriminatedUnion("representation", [
    htmlArtifactSchema,
    openUIArtifactSchema,
  ]),
);

const artifactEnvelopeSchema = z
  .object({ artifact: richArtifactSchema })
  .strict();
const artifactListEnvelopeSchema = z
  .object({
    artifacts: z.array(richArtifactSchema),
  })
  .strict();
const richArtifactDetailSchema = z.union([
  z.object({ artifact: htmlArtifactSchema, html: z.string() }).strict(),
  z
    .object({
      artifact: openUIArtifactSchema,
      openui: z.string().max(64 * 1024),
    })
    .strict(),
]);

export async function createRichArtifact(
  params: CreateRichArtifactParams,
): Promise<RichArtifact> {
  const res = await post<unknown>("/visual-artifacts", {
    slug: params.slug,
    title: params.title,
    summary: params.summary ?? "",
    openui_lang: params.openuiLang,
    source_markdown_path: params.sourceMarkdownPath,
    related_task_id: params.relatedTaskId,
    related_message_id: params.relatedMessageId,
    related_receipt_ids: params.relatedReceiptIds ?? [],
    commit_message: params.commitMessage,
  });
  return artifactEnvelopeSchema.parse(res).artifact;
}

export async function fetchRichArtifacts(params: {
  slug?: string;
  sourceMarkdownPath?: string;
}): Promise<RichArtifact[]> {
  const query: Record<string, string> = {};
  if (params.slug) query.slug = params.slug;
  if (params.sourceMarkdownPath) {
    query.source_path = params.sourceMarkdownPath;
  }
  const res = await get<unknown>("/visual-artifacts", query);
  return artifactListEnvelopeSchema.parse(res).artifacts;
}

export async function fetchRichArtifact(
  id: string,
): Promise<RichArtifactDetail> {
  const response = await get<unknown>(
    `/visual-artifacts/${encodeURIComponent(id)}`,
    { accept_representation: "openui" },
  );
  return richArtifactDetailSchema.parse(response);
}

export async function promoteRichArtifact(
  id: string,
  params: PromoteRichArtifactParams,
): Promise<RichArtifact> {
  const res = await post<unknown>(
    `/visual-artifacts/${encodeURIComponent(id)}/promote`,
    {
      target_wiki_path: params.targetWikiPath,
      markdown_summary: params.markdownSummary,
      mode: params.mode ?? "create",
      commit_message: params.commitMessage,
    },
  );
  return artifactEnvelopeSchema.parse(res).artifact;
}

// ArtifactDestination describes where a clickable reference to an artifact
// should navigate. It is intentionally shaped like a router NavigateOptions
// payload (to + params) so call sites can splat it straight into
// router.navigate(). The resolver derives the destination from the new
// promotion field when present, then falls back to legacy fields, and
// finally to the standalone /articles/$id viewer.
export type ArtifactDestination =
  | {
      to: "/wiki/$";
      params: { _splat: string };
    }
  | {
      to: "/articles/$articleId";
      params: { articleId: string };
    };

// stripWikiSuffix lops off the trailing ".md" (if any) so the wiki splat
// matches the same shape the router uses for in-app navigation (e.g.
// "team/reference/coffee" instead of "team/reference/coffee.md"). The wiki
// route handler accepts both, but the trimmed form keeps the URL clean.
function stripWikiSuffix(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function resolveArtifactDestination(
  artifact: Pick<
    RichArtifact,
    "id" | "promotion" | "promotedWikiPath" | "attached_to_notebook_entry"
  >,
): ArtifactDestination {
  const { promotion } = artifact;
  if (promotion?.status === "promoted_to_wiki" && promotion.wiki_path) {
    return {
      to: "/wiki/$",
      params: { _splat: stripWikiSuffix(promotion.wiki_path) },
    };
  }
  // Legacy fallback for artifacts emitted before the promotion field
  // existed: if we know a wiki path was set, route there. Runs only when no
  // promotion field is present so an explicit `draft` promotion still wins.
  // The notebook surface has been retired, so notebook-promoted /
  // notebook-attached artifacts fall through to the standalone /articles/$id
  // viewer below.
  if (!promotion && artifact.promotedWikiPath) {
    return {
      to: "/wiki/$",
      params: { _splat: stripWikiSuffix(artifact.promotedWikiPath) },
    };
  }
  // Draft / notebook / unknown / unpromoted: fall back to the standalone
  // viewer.
  return {
    to: "/articles/$articleId",
    params: { articleId: artifact.id },
  };
}

export async function fetchWikiVisualArtifact(
  path: string,
): Promise<RichArtifactDetail | null> {
  try {
    const response = await get<unknown>("/wiki/visual", {
      path,
      accept_representation: "openui",
    });
    return richArtifactDetailSchema.parse(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/404|not found/i.test(message)) {
      return null;
    }
    console.warn("Failed to fetch wiki visual artifact", err);
    throw err;
  }
}
