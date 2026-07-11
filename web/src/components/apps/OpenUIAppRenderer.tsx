import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import {
  createParser,
  type OpenUIError,
  type ParseResult,
  Renderer,
} from "@openuidev/react-lang";
import { z } from "zod/v4";

import { get, getText, post } from "../../api/client";
import { getHumanMe, type HumanMe } from "../../api/platform";
import { openUIAppLibrary } from "../../lib/openUIAppLibrary";
import { confirm } from "../ui/ConfirmDialog";
import { showNotice } from "../ui/Toast";

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_STATEMENTS = 512;
const MAX_ACTIVE_TOOLS = 12;
const MIN_REFRESH_SECONDS = 15;

const queryTools = new Set([
  "wuphf_list_tasks",
  "wuphf_list_office_members",
  "wuphf_list_channels",
  "wuphf_list_requests",
  "wuphf_wiki_list",
  "wuphf_wiki_read",
  "wuphf_list_integrations",
  "wuphf_app_db_query",
]);
const mutationTools = new Set([
  "wuphf_create_task",
  "wuphf_call_integration",
  "wuphf_app_db_define",
  "wuphf_app_db_upsert",
  "wuphf_app_db_clear",
]);

type AppValidation =
  | { ok: true; result: ParseResult }
  | { ok: false; code: string };

export function validateOpenUIApp(source: string): AppValidation {
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES)
    return { ok: false, code: "openui_source_budget" };
  if (
    /@(?:OpenUrl|ToAssistant)\s*\(/i.test(source) ||
    /https?:\/\//i.test(source)
  )
    return { ok: false, code: "openui_forbidden_action" };
  let result: ParseResult;
  try {
    result = createParser(openUIAppLibrary.toJSONSchema()).parse(source);
  } catch {
    return { ok: false, code: "openui_parse_exception" };
  }
  if (!result.root) return { ok: false, code: "openui_missing_root" };
  if (
    result.meta.incomplete ||
    result.meta.errors.length ||
    result.meta.unresolved.length ||
    result.meta.orphaned.length
  )
    return { ok: false, code: "openui_parse_error" };
  const policyFailure = validateOpenUIAppTools(result, source);
  if (policyFailure) return { ok: false, code: policyFailure };
  return { ok: true, result };
}

function validateOpenUIAppTools(
  result: ParseResult,
  source: string,
): string | null {
  if (
    result.meta.statementCount > MAX_STATEMENTS ||
    result.queryStatements.length + result.mutationStatements.length >
      MAX_ACTIVE_TOOLS
  ) {
    return "openui_statement_budget";
  }
  return (
    validateOpenUIQueries(result) ?? validateOpenUIMutations(result, source)
  );
}

function validateOpenUIQueries(result: ParseResult): string | null {
  for (const query of result.queryStatements) {
    if (query.toolAST?.k !== "Str" || !queryTools.has(query.toolAST.v))
      return "openui_query_tool";
    if (
      query.refreshAST &&
      (query.refreshAST.k !== "Num" || query.refreshAST.v < MIN_REFRESH_SECONDS)
    )
      return "openui_refresh_budget";
  }
  return null;
}

function validateOpenUIMutations(
  result: ParseResult,
  source: string,
): string | null {
  for (const mutation of result.mutationStatements) {
    if (mutation.toolAST?.k !== "Str" || !mutationTools.has(mutation.toolAST.v))
      return "openui_mutation_tool";
    const escaped = mutation.statementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`@Run\\(\\s*${escaped}\\s*\\)`).test(source))
      return "openui_unbound_mutation";
  }
  return null;
}

const wikiReadArgs = z.object({ path: z.string().min(1).max(500) }).strict();
const dbTableArgs = z
  .object({ table: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/) })
  .strict();
const createTaskArgs = z
  .object({
    title: z.string().min(1).max(200),
    details: z.string().max(8_000).optional(),
  })
  .strict();
const integrationArgs = z
  .object({
    platform: z.string().min(1).max(100),
    action: z.string().min(1).max(160),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const defineArgs = dbTableArgs
  .extend({ columns: z.array(z.unknown()).min(1).max(40) })
  .strict();
const upsertArgs = dbTableArgs
  .extend({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
    key: z.string().max(64).optional(),
  })
  .strict();

let openUIAppMutationPending = false;

async function confirmedMutation<T>(
  title: string,
  message: string,
  danger: boolean,
  run: () => Promise<T>,
): Promise<T> {
  if (openUIAppMutationPending) {
    throw new Error("Another app action is already awaiting confirmation.");
  }
  openUIAppMutationPending = true;
  try {
    return await new Promise((resolve, reject) =>
      confirm({
        title,
        message,
        danger,
        confirmLabel: danger ? "Confirm action" : "Continue",
        onCancel: () => reject(new Error("Action cancelled by the user.")),
        onConfirm: async () => {
          try {
            resolve(await run());
          } catch (error) {
            reject(error);
          }
        },
      }),
    );
  } finally {
    openUIAppMutationPending = false;
  }
}

function boundedResult(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded.length > 512_000)
    throw new Error("Tool result exceeded the app data limit.");
  return value;
}

export function openUIHumanActor(me: HumanMe): string {
  const memberSlug = me.human.human_slug?.trim();
  if (memberSlug) return `human:${memberSlug}`;
  const slug = me.human.slug?.trim();
  if (slug) return slug === "human" ? slug : `human:${slug}`;
  throw new Error("Could not resolve the signed-in human identity.");
}

function formatMutationPayload(value: unknown): string {
  const formatted = JSON.stringify(value, null, 2);
  if (formatted === undefined) {
    throw new Error("Mutation payload could not be displayed for review.");
  }
  return formatted;
}

export function readArrayEnvelope(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [];
  const candidate = (value as Readonly<Record<string, unknown>>)[key];
  return Array.isArray(candidate) ? candidate : [];
}

export function createOpenUIAppToolProvider(appId: string) {
  const dbBase = `/apps/${encodeURIComponent(appId)}/db`;
  let humanActorPromise: Promise<string> | undefined;
  const humanActor = () => {
    humanActorPromise ??= getHumanMe().then(openUIHumanActor);
    return humanActorPromise;
  };
  return {
    wuphf_list_tasks: async () => {
      const viewerSlug = await humanActor();
      return boundedResult(
        readArrayEnvelope(
          await get("/tasks", {
            all_channels: true,
            include_done: true,
            viewer_slug: viewerSlug,
          }),
          "tasks",
        ),
      );
    },
    wuphf_list_office_members: async () =>
      boundedResult(readArrayEnvelope(await get("/office-members"), "members")),
    wuphf_list_channels: async () =>
      boundedResult(readArrayEnvelope(await get("/channels"), "channels")),
    wuphf_list_requests: async () =>
      boundedResult(readArrayEnvelope(await get("/requests"), "requests")),
    wuphf_wiki_list: async () =>
      boundedResult(readArrayEnvelope(await get("/wiki/catalog"), "articles")),
    wuphf_wiki_read: async (raw: Record<string, unknown>) => {
      const args = wikiReadArgs.parse(raw);
      return boundedResult({
        path: args.path,
        content: await getText("/wiki/read", { path: args.path }),
      });
    },
    wuphf_list_integrations: async () =>
      boundedResult(await get("/apps/integrations/catalog")),
    wuphf_app_db_query: async (raw: Record<string, unknown>) => {
      const args = dbTableArgs.parse(raw);
      return boundedResult(
        await post(dbBase, { op: "query", table: args.table }),
      );
    },
    wuphf_create_task: async (raw: Record<string, unknown>) => {
      const args = createTaskArgs.parse(raw);
      const actor = await humanActor();
      return confirmedMutation(
        "Create office task",
        `OpenUI app requests wuphf_create_task:\n\n${args.title}`,
        false,
        async () => {
          const result = await post("/tasks", {
            action: "create",
            channel: "general",
            title: args.title,
            details: args.details ?? "",
            created_by: actor,
            task_type: "issue",
          });
          showNotice(`Created task: ${args.title}`, "success");
          return boundedResult(result);
        },
      );
    },
    wuphf_call_integration: async (raw: Record<string, unknown>) => {
      const args = integrationArgs.parse(raw);
      return confirmedMutation(
        "Run integration action",
        `OpenUI app requests ${args.platform} / ${args.action}:\n\n${formatMutationPayload(args.params ?? {})}`,
        true,
        async () =>
          boundedResult(
            await post("/apps/integrations/call", { ...args, app_id: appId }),
          ),
      );
    },
    wuphf_app_db_define: async (raw: Record<string, unknown>) => {
      const args = defineArgs.parse(raw);
      return confirmedMutation(
        "Change app data model",
        `OpenUI app requests wuphf_app_db_define for table “${args.table}” with ${args.columns.length} column(s):\n\n${formatMutationPayload(args.columns)}`,
        false,
        async () =>
          boundedResult(await post(dbBase, { op: "define", ...args })),
      );
    },
    wuphf_app_db_upsert: async (raw: Record<string, unknown>) => {
      const args = upsertArgs.parse(raw);
      return confirmedMutation(
        "Write app data",
        `OpenUI app requests wuphf_app_db_upsert of ${args.rows.length} row(s) in “${args.table}”:\n\n${formatMutationPayload(args.rows)}`,
        false,
        async () =>
          boundedResult(await post(dbBase, { op: "upsert", ...args })),
      );
    },
    wuphf_app_db_clear: async (raw: Record<string, unknown>) => {
      const args = dbTableArgs.parse(raw);
      return confirmedMutation(
        "Clear app data",
        `OpenUI app requests wuphf_app_db_clear for table “${args.table}”. This cannot be undone from the app.`,
        true,
        async () =>
          boundedResult(await post(dbBase, { op: "clear", table: args.table })),
      );
    },
  };
}

export function OpenUIAppRenderer(props: {
  appId: string;
  title: string;
  openui: string;
}) {
  return (
    <OpenUIAppErrorBoundary key={openUIRendererKey(props.appId, props.openui)}>
      <OpenUIAppRendererInner {...props} />
    </OpenUIAppErrorBoundary>
  );
}

export function openUIRendererKey(appId: string, source: string): string {
  return `${appId}:${source}`;
}

function OpenUIAppRendererInner({
  appId,
  title,
  openui,
}: {
  appId: string;
  title: string;
  openui: string;
}) {
  const [runtimeErrors, setRuntimeErrors] = useState<OpenUIError[]>([]);
  const validation = useMemo(() => validateOpenUIApp(openui), [openui]);
  const provider = useMemo(() => createOpenUIAppToolProvider(appId), [appId]);
  if (!validation.ok || runtimeErrors.length)
    return (
      <div className="app-build-preview__state" role="alert">
        <p className="app-build-preview__state-title">App unavailable</p>
        <p className="app-build-preview__state-detail">
          {validation.ok ? "OpenUI runtime error" : validation.code}
        </p>
      </div>
    );
  return (
    <section
      className="openui-app-renderer"
      data-testid="openui-app-renderer"
      aria-label={title}
    >
      <Renderer
        library={openUIAppLibrary}
        response={openui}
        isStreaming={false}
        toolProvider={provider}
        onError={(errors) => {
          if (errors.length) setRuntimeErrors(errors);
        }}
      />
    </section>
  );
}

class OpenUIAppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("OpenUI App render failed", error.name, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="app-build-preview__state" role="alert">
          <p className="app-build-preview__state-title">App unavailable</p>
          <p className="app-build-preview__state-detail">
            The OpenUI renderer could not display this app.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
