import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { z } from "zod/v4";

const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);
const textTone = z.enum(["default", "muted", "accent"]);

function keyedValues<T>(items: T[], serialize: (value: T) => string) {
  const counts = new Map<string, number>();
  return items.map((value, index) => {
    const base = serialize(value);
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    return { value, index, key: `${base}:${occurrence}` };
  });
}

const Heading = defineComponent({
  name: "Heading",
  description: "A section heading. Level is 1, 2, or 3.",
  props: z.object({ text: z.string(), level: z.enum(["1", "2", "3"]) }),
  component: ({ props }) => {
    const Tag = `h${props.level}` as "h1" | "h2" | "h3";
    return (
      <Tag className={`openui-artifact-heading level-${props.level}`}>
        {props.text}
      </Tag>
    );
  },
});

const Text = defineComponent({
  name: "Text",
  description:
    "A paragraph of plain text. Markdown and HTML are not supported.",
  props: z.object({ text: z.string(), tone: textTone.optional() }),
  component: ({ props }) => (
    <p className={`openui-artifact-text tone-${props.tone ?? "default"}`}>
      {props.text}
    </p>
  ),
});

const Badge = defineComponent({
  name: "Badge",
  description: "A short status label.",
  props: z.object({ label: z.string(), tone: tone.optional() }),
  component: ({ props }) => (
    <span className={`openui-artifact-badge tone-${props.tone ?? "neutral"}`}>
      {props.label}
    </span>
  ),
});

const Metric = defineComponent({
  name: "Metric",
  description: "A labeled metric with an optional explanatory detail.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    detail: z.string().optional(),
    tone: tone.optional(),
  }),
  component: ({ props }) => (
    <div className={`openui-artifact-metric tone-${props.tone ?? "neutral"}`}>
      <span className="openui-artifact-metric-label">{props.label}</span>
      <strong className="openui-artifact-metric-value">{props.value}</strong>
      {props.detail ? (
        <span className="openui-artifact-metric-detail">{props.detail}</span>
      ) : null}
    </div>
  ),
});

const Callout = defineComponent({
  name: "Callout",
  description: "A highlighted title and plain-text explanation.",
  props: z.object({
    title: z.string(),
    body: z.string(),
    tone: tone.optional(),
  }),
  component: ({ props }) => (
    <aside className={`openui-artifact-callout tone-${props.tone ?? "info"}`}>
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </aside>
  ),
});

const Code = defineComponent({
  name: "Code",
  description: "A non-executable plain-text code or configuration block.",
  props: z.object({ code: z.string(), language: z.string().optional() }),
  component: ({ props }) => (
    <figure className="openui-artifact-code">
      {props.language ? <figcaption>{props.language}</figcaption> : null}
      <pre>
        <code>{props.code}</code>
      </pre>
    </figure>
  ),
});

const Divider = defineComponent({
  name: "Divider",
  description: "A visual divider with an optional short label.",
  props: z.object({ label: z.string().optional() }),
  component: ({ props }) => (
    <div className="openui-artifact-divider">
      {props.label ? <span>{props.label}</span> : null}
    </div>
  ),
});

const List = defineComponent({
  name: "List",
  description: "A list of plain-text items.",
  props: z.object({
    items: z.array(z.string()),
    ordered: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const Tag = props.ordered ? "ol" : "ul";
    return (
      <Tag className="openui-artifact-list">
        {keyedValues(props.items, String).map(({ key, value }) => (
          <li key={key}>{value}</li>
        ))}
      </Tag>
    );
  },
});

const Table = defineComponent({
  name: "Table",
  description:
    "A compact static table. Every row should have the same number of cells as columns.",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    caption: z.string().optional(),
  }),
  component: ({ props }) => (
    <div className="openui-artifact-table-wrap">
      <table className="openui-artifact-table">
        {props.caption ? <caption>{props.caption}</caption> : null}
        <thead>
          <tr>
            {keyedValues(props.columns, String).map(({ key, value }) => (
              <th key={key} scope="col">
                {value}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keyedValues(props.rows, (row) => JSON.stringify(row)).map(
            ({ key: rowKey, value: row }) => (
              <tr key={rowKey}>
                {keyedValues(props.columns, String).map(
                  ({ key: columnKey, index: cellIndex }) => (
                    <td key={columnKey}>{row[cellIndex] ?? ""}</td>
                  ),
                )}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  ),
});

const BarChart = defineComponent({
  name: "BarChart",
  description:
    "A static horizontal bar chart. Labels and values must have matching lengths and values must be non-negative.",
  props: z.object({
    title: z.string(),
    labels: z.array(z.string()),
    values: z.array(z.number()),
    unit: z.string().optional(),
  }),
  component: ({ props }) => {
    const safeValues = props.values.map((value) => Math.max(0, value));
    const max = Math.max(1, ...safeValues);
    return (
      <figure className="openui-artifact-chart">
        <figcaption>{props.title}</figcaption>
        <div className="openui-artifact-chart-rows">
          {keyedValues(props.labels, String).map(
            ({ key, value: label, index }) => {
              const value = safeValues[index] ?? 0;
              return (
                <div className="openui-artifact-chart-row" key={key}>
                  <span className="openui-artifact-chart-label">{label}</span>
                  <span
                    className="openui-artifact-chart-track"
                    aria-hidden="true"
                  >
                    <span style={{ width: `${(value / max) * 100}%` }} />
                  </span>
                  <strong>
                    {value}
                    {props.unit ?? ""}
                  </strong>
                </div>
              );
            },
          )}
        </div>
      </figure>
    );
  },
});

const leafComponents = [
  Heading,
  Text,
  Badge,
  Metric,
  Callout,
  Code,
  Divider,
  List,
  Table,
  BarChart,
] as const;

const leafRef = z.union(leafComponents.map((component) => component.ref));

const Section = defineComponent({
  name: "Section",
  description: "A titled document section containing static review components.",
  props: z.object({ title: z.string(), children: z.array(leafRef) }),
  component: ({ props, renderNode }) => (
    <section className="openui-artifact-section">
      <h2>{props.title}</h2>
      <div className="openui-artifact-section-body">
        {renderNode(props.children)}
      </div>
    </section>
  ),
});

const rootChild = z.union([
  ...leafComponents.map((component) => component.ref),
  Section.ref,
]);

const Stack = defineComponent({
  name: "Stack",
  description:
    "The required document root. Children render vertically in reading order.",
  props: z.object({
    children: z.array(rootChild),
    gap: z.enum(["s", "m", "l"]).optional(),
  }),
  component: ({ props, renderNode }) => (
    <div className={`openui-artifact-stack gap-${props.gap ?? "m"}`}>
      {renderNode(props.children)}
    </div>
  ),
});

export const openUIArtifactLibrary = createLibrary({
  root: "Stack",
  components: [...leafComponents, Section, Stack],
  componentGroups: [
    {
      name: "Document",
      components: ["Stack", "Section", "Heading", "Text", "Divider"],
    },
    {
      name: "Evidence",
      components: ["Metric", "Table", "BarChart", "List", "Code"],
    },
    { name: "Emphasis", components: ["Callout", "Badge"] },
  ],
});

export const openUIArtifactPromptOptions = {
  preamble:
    "Generate a static WUPHF review artifact in OpenUI Lang v0.5. The output is persisted and rendered as an inert document.",
  additionalRules: [
    "Output OpenUI Lang only, with one assignment per line and root first.",
    "Always begin with root = Stack([...]).",
    "Use only components in this library and positional arguments in their documented order.",
    "Keep prose in plain strings. Never emit HTML, Markdown, URLs, images, forms, actions, state, Query, or Mutation.",
    "Keep tables compact and make every row match the column count.",
    "Keep arrays and charts concise; summarize large datasets instead of embedding them.",
  ],
  toolCalls: false,
  bindings: false,
  inlineMode: false,
  editMode: false,
} as const;
