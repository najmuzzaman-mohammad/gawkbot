import {
  type ActionPlan,
  createLibrary,
  defineComponent,
  reactive,
  useStateField,
  useTriggerAction,
} from "@openuidev/react-lang";
import { z } from "zod/v4";

const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);
const gap = z.enum(["s", "m", "l"]);

function keyedValues<T>(items: T[], serialize: (value: T) => string) {
  const counts = new Map<string, number>();
  return items.map((value, index) => {
    const base = serialize(value);
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    return { value, index, key: `${base}:${occurrence}` };
  });
}

function reactiveValue<T>(
  value: { readonly value: T } | T | null | undefined,
  fallback: T,
): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return (value as { readonly value: T }).value ?? fallback;
  }
  return value as T;
}

const Heading = defineComponent({
  name: "Heading",
  description: "A heading with a semantic level from 1 to 3.",
  props: z.object({
    text: reactive(z.string()),
    level: z.enum(["1", "2", "3"]).optional(),
  }),
  component: ({ props }) => {
    const Tag = `h${props.level ?? "2"}` as "h1" | "h2" | "h3";
    return (
      <Tag className={`openui-app-heading level-${props.level ?? "2"}`}>
        {reactiveValue(props.text, "")}
      </Tag>
    );
  },
});

const Text = defineComponent({
  name: "Text",
  description: "Plain application text. HTML and Markdown are not supported.",
  props: z.object({
    text: reactive(z.string()),
    muted: z.boolean().optional(),
  }),
  component: ({ props }) => (
    <p className={props.muted ? "openui-app-text muted" : "openui-app-text"}>
      {reactiveValue(props.text, "")}
    </p>
  ),
});

const Badge = defineComponent({
  name: "Badge",
  description: "A compact status label.",
  props: z.object({ label: reactive(z.string()), tone: tone.optional() }),
  component: ({ props }) => (
    <span className={`openui-app-badge tone-${props.tone ?? "neutral"}`}>
      {reactiveValue(props.label, "")}
    </span>
  ),
});

const Metric = defineComponent({
  name: "Metric",
  description: "A prominent value with a short label and optional detail.",
  props: z.object({
    label: z.string(),
    value: reactive(z.union([z.string(), z.number()])),
    detail: reactive(z.string()).optional(),
    tone: tone.optional(),
  }),
  component: ({ props }) => (
    <div className={`openui-app-metric tone-${props.tone ?? "neutral"}`}>
      <span>{props.label}</span>
      <strong>{reactiveValue(props.value, "")}</strong>
      {props.detail ? <small>{reactiveValue(props.detail, "")}</small> : null}
    </div>
  ),
});

const Callout = defineComponent({
  name: "Callout",
  description: "A visible informational, success, warning, or error message.",
  props: z.object({ body: reactive(z.string()), tone: tone.optional() }),
  component: ({ props }) => (
    <div
      className={`openui-app-callout tone-${props.tone ?? "info"}`}
      role={props.tone === "danger" ? "alert" : "status"}
    >
      {reactiveValue(props.body, "")}
    </div>
  ),
});

const List = defineComponent({
  name: "List",
  description:
    "A compact list of strings, including a Query result projected to strings.",
  props: z.object({
    items: reactive(z.array(z.string())),
    emptyText: z.string().optional(),
  }),
  component: ({ props }) => {
    const items = reactiveValue<string[]>(props.items, []);
    return items.length ? (
      <ul className="openui-app-list">
        {keyedValues(items, String).map(({ value, key }) => (
          <li key={key}>{value}</li>
        ))}
      </ul>
    ) : (
      <p className="openui-app-empty">{props.emptyText ?? "No items yet."}</p>
    );
  },
});

const Table = defineComponent({
  name: "Table",
  description: "A data table. Rows are arrays whose cells align with columns.",
  props: z.object({
    columns: z.array(z.string()),
    rows: reactive(
      z.array(
        z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
      ),
    ),
    emptyText: z.string().optional(),
  }),
  component: ({ props }) => {
    const rows = reactiveValue<Array<Array<string | number | boolean | null>>>(
      props.rows,
      [],
    );
    return (
      <div className="openui-app-table-wrap">
        <table className="openui-app-table">
          <thead>
            <tr>
              {props.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keyedValues(rows, JSON.stringify).map(({ value: row, key }) => (
              <tr key={key}>
                {keyedValues(props.columns, String).map(
                  ({ index, key: columnKey }) => (
                    <td key={columnKey}>{String(row[index] ?? "")}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="openui-app-empty">{props.emptyText ?? "No results."}</p>
        ) : null}
      </div>
    );
  },
});

const DataTable = defineComponent({
  name: "DataTable",
  description:
    "A table for Query results that are arrays of objects. Columns map a visible label to an exact object key.",
  props: z.object({
    columns: z.array(z.object({ label: z.string(), key: z.string() })),
    rows: reactive(z.array(z.record(z.string(), z.unknown()))),
    emptyText: z.string().optional(),
  }),
  component: ({ props }) => {
    const rows = reactiveValue<Array<Record<string, unknown>>>(props.rows, []);
    return (
      <div className="openui-app-table-wrap">
        <table className="openui-app-table">
          <thead>
            <tr>
              {props.columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keyedValues(rows, JSON.stringify).map(({ value: row, key }) => (
              <tr key={key}>
                {props.columns.map((column) => (
                  <td key={column.key}>{String(row[column.key] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="openui-app-empty">{props.emptyText ?? "No results."}</p>
        ) : null}
      </div>
    );
  },
});

const Progress = defineComponent({
  name: "Progress",
  description: "A labeled progress indicator from 0 to 100.",
  props: z.object({ label: z.string(), value: reactive(z.number()) }),
  component: ({ props }) => {
    const value = Math.max(0, Math.min(100, reactiveValue(props.value, 0)));
    return (
      <div className="openui-app-progress">
        <span>{props.label}</span>
        <div>
          <i style={{ width: `${value}%` }} />
        </div>
        <strong>{value}%</strong>
      </div>
    );
  },
});

const TextInput = defineComponent({
  name: "TextInput",
  description: "A text input bound to a $state variable. Name must be unique.",
  props: z.object({
    name: z.string(),
    label: z.string(),
    value: reactive(z.string()),
    placeholder: z.string().optional(),
  }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    return (
      <label className="openui-app-field">
        <span>{props.label}</span>
        <input
          name={props.name}
          value={field.value ?? ""}
          placeholder={props.placeholder}
          onChange={(event) => field.setValue(event.target.value)}
        />
      </label>
    );
  },
});

const Select = defineComponent({
  name: "Select",
  description: "A select input bound to a $state variable.",
  props: z.object({
    name: z.string(),
    label: z.string(),
    value: reactive(z.string()),
    options: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    return (
      <label className="openui-app-field">
        <span>{props.label}</span>
        <select
          name={props.name}
          value={field.value ?? ""}
          onChange={(event) => field.setValue(event.target.value)}
        >
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  },
});

const Button = defineComponent({
  name: "Button",
  description:
    "A user-triggered action. Use @Run for Mutation, and @Set/@Reset for state changes.",
  props: z.object({
    label: z.string(),
    action: z.unknown(),
    tone: tone.optional(),
    disabled: reactive(z.boolean()).optional(),
  }),
  component: ({ props }) => {
    const trigger = useTriggerAction();
    return (
      <button
        className={`openui-app-button tone-${props.tone ?? "neutral"}`}
        type="button"
        disabled={reactiveValue(props.disabled, false)}
        onClick={() =>
          void trigger(props.label, undefined, props.action as ActionPlan)
        }
      >
        {props.label}
      </button>
    );
  },
});

const leaves = [
  Heading,
  Text,
  Badge,
  Metric,
  Callout,
  List,
  Table,
  DataTable,
  Progress,
  TextInput,
  Select,
  Button,
] as const;
const leafRef = z.union(leaves.map((component) => component.ref));

const Card = defineComponent({
  name: "Card",
  description: "A grouped region with an optional title.",
  props: z.object({ title: z.string().optional(), children: z.array(leafRef) }),
  component: ({ props, renderNode }) => (
    <section className="openui-app-card">
      {props.title ? <h2>{props.title}</h2> : null}
      <div>{renderNode(props.children)}</div>
    </section>
  ),
});

const Stack = defineComponent({
  name: "Stack",
  description: "A vertical layout for leaf components.",
  props: z.object({ children: z.array(leafRef), gap: gap.optional() }),
  component: ({ props, renderNode }) => (
    <div className={`openui-app-stack gap-${props.gap ?? "m"}`}>
      {renderNode(props.children)}
    </div>
  ),
});

const rootChild = z.union([
  ...leaves.map((component) => component.ref),
  Card.ref,
  Stack.ref,
]);
const App = defineComponent({
  name: "App",
  description:
    "The required root application surface, with a concise title and ordered children.",
  props: z.object({ title: z.string(), children: z.array(rootChild) }),
  component: ({ props, renderNode }) => (
    <main className="openui-app">
      <header className="openui-app-header">
        <h1>{props.title}</h1>
      </header>
      <div className="openui-app-body">{renderNode(props.children)}</div>
    </main>
  ),
});

export const openUIAppLibrary = createLibrary({
  root: "App",
  components: [...leaves, Card, Stack, App],
  componentGroups: [
    { name: "Layout", components: ["App", "Card", "Stack"] },
    {
      name: "Content",
      components: ["Heading", "Text", "Badge", "Metric", "Callout"],
    },
    {
      name: "Data",
      components: ["List", "Table", "DataTable", "Progress"],
    },
    {
      name: "Input and actions",
      components: ["TextInput", "Select", "Button"],
    },
  ],
});

export const openUIAppTools = [
  {
    name: "wuphf_list_tasks",
    description: "List office tasks across channels.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "array" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wuphf_list_office_members",
    description: "List office members.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "array" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wuphf_list_channels",
    description: "List workspace channels.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "array" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wuphf_list_requests",
    description: "List workspace requests and approvals.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "array" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wuphf_wiki_list",
    description: "List curated wiki pages.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "array" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wuphf_wiki_read",
    description: "Read one curated wiki page.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wuphf_list_integrations",
    description: "List connected integration catalog entries.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wuphf_app_db_query",
    description: "Query a table in this app's private store.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string" } },
      required: ["table"],
    },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wuphf_create_task",
    description:
      "Create an office task after a non-spoofable host confirmation.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, details: { type: "string" } },
      required: ["title"],
    },
    outputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
  {
    name: "wuphf_call_integration",
    description:
      "Call an integration action after host confirmation naming the exact platform and action.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string" },
        action: { type: "string" },
        params: { type: "object" },
      },
      required: ["platform", "action"],
    },
    outputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
  {
    name: "wuphf_app_db_define",
    description: "Define a table in this app's private store.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string" }, columns: { type: "array" } },
      required: ["table", "columns"],
    },
    outputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
  {
    name: "wuphf_app_db_upsert",
    description: "Upsert rows in this app's private store.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        rows: { type: "array" },
        key: { type: "string" },
      },
      required: ["table", "rows"],
    },
    outputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
  {
    name: "wuphf_app_db_clear",
    description:
      "Clear a table in this app's private store after host confirmation.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string" } },
      required: ["table"],
    },
    outputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
] as const;

export const openUIAppPromptOptions = {
  preamble:
    "Generate a complete WUPHF internal app in OpenUI Lang v0.5. WUPHF renders it with the executable wuphf-app-v1 component library and connects its declared tools to the signed-in workspace backend.",
  additionalRules: [
    "Output OpenUI Lang only, one assignment per line, with root first.",
    'Always begin with root = App("Title", [...]).',
    "Do not output React, JSX, TypeScript, JavaScript, HTML, CSS, Markdown, a package.json, or build commands.",
    "Use only the supplied components and tools. Tool names must always be literal strings.",
    "Queries may run on mount. Mutations must only run from an explicit Button action with @Run.",
    "Never emit @OpenUrl, @ToAssistant, URLs, images, arbitrary network access, or automatic mutation retries.",
    "Use $state plus TextInput or Select for user inputs. Show useful empty, loading-friendly, and error-aware copy.",
    "Keep the app focused: at most 12 tools, 512 statements, and compact result views.",
  ],
  toolExamples: [
    `root = App("Task desk", [Heading("Office tasks", "2"), DataTable([{"label":"Task","key":"title"},{"label":"Status","key":"status"},{"label":"Owner","key":"owner"}], tasks, "No tasks yet.")])
tasks = Query("wuphf_list_tasks", {}, [])`,
    `root = App("Follow-up", [TextInput("title", "Task title", $title, "What needs doing?"), Button("Create task", @Run(createTask), "info")])
$title = ""
createTask = Mutation("wuphf_create_task", {"title":$title})`,
  ],
  tools: [...openUIAppTools],
  toolCalls: true,
  bindings: true,
  inlineMode: false,
  editMode: false,
} as const;
