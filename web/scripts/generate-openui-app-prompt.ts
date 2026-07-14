import {
  openUIAppLibrary,
  openUIAppPromptOptions,
} from "../src/lib/openUIAppLibrary";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const outputPath = resolve(root, "internal/openuiapp/system_prompt.txt");
const goContractPath = resolve(root, "internal/openuiapp/prompt.go");
const storePath = resolve(root, "internal/team/custom_app.go");
const webContractPath = resolve(root, "web/src/api/apps.ts");
const libraryPath = resolve(root, "web/src/lib/openUIAppLibrary.tsx");
const runtimeGuidance = `IMPORTANT @Each rule: The loop variable (for example, "item") is available only inside the @Each template expression. Keep repeated-row templates inline.
CORRECT: \`Stack(@Each(rows, "t", Button("Edit", @Set($id, t.id))))\`
WRONG: define a separate Button statement that references \`t\` outside @Each.

## Query — Live Data Fetching

Use \`result = Query("tool_name", {args}, fallback, refreshSeconds?)\`. Query identifiers are regular names, not $state. Arguments may reference $state and re-fetch when it changes. Use a refresh interval of at least 15 seconds.

Manual refresh uses a WUPHF Button action directly: \`Button("Refresh", @Run(tasks), "info")\`.

## Mutation — Write Operations

Use \`result = Mutation("tool_name", {args})\`. A Mutation runs only from an explicit action such as \`Button("Create", @Run(createTask), "info")\`. WUPHF displays the actual mutation payload in trusted host confirmation chrome before executing it.

## Interactive Inputs

Bind WUPHF inputs directly to $state:
\`$title = ""\`
\`titleInput = TextInput("title", "Task title", $title, "What needs doing?")\`
\`$status = "open"\`
\`statusInput = Select("status", "Status", $status, [{"label":"Open","value":"open"},{"label":"Done","value":"done"}])\`

Every visible filter must appear in each relevant Query argument object. $state holds simple values, not arrays or objects.

## Data Workflow

1. Inspect the real tool result shape before generating the app.
2. Use Query for live reads and Mutation for writes.
3. Match each Query fallback to the tool's advertised return type.
4. Derive metrics and rows from Query results with @Count, @Filter, @Sort, @Sum, and @Each.
5. Keep @Each row variables inside the inline template.
6. Use only WUPHF components listed above. Do not invent Form, FormControl, Input, SelectItem, Col, Action, or TextContent.

Example:
\`root = App("Task desk", [titleInput, createButton, tasksTable])\`
\`$title = ""\`
\`titleInput = TextInput("title", "Task title", $title, "What needs doing?")\`
\`tasks = Query("wuphf_list_tasks", {}, [])\`
\`createTask = Mutation("wuphf_create_task", {"title":$title})\`
\`createButton = Button("Create", @Run(createTask), "info")\`
\`tasksTable = DataTable([{"label":"Task","key":"title"}], tasks, "No tasks yet.")\`

`;

function replaceSection(
  source: string,
  start: string,
  end: string,
  replacement: string,
) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt);
  if (startAt < 0 || endAt < 0) {
    throw new Error(`missing generated prompt section: ${start} ... ${end}`);
  }
  return `${source.slice(0, startAt)}${replacement}${source.slice(endAt)}`;
}

const generatedPrompt = openUIAppLibrary
  .prompt(openUIAppPromptOptions)
  .replace(
    "\n- Strings use double quotes with backslash escaping",
    "\n17. Strings use double quotes with backslash escaping",
  );
const prompt = `${replaceSection(
  generatedPrompt,
  "IMPORTANT @Each rule:",
  "## Available Tools",
  runtimeGuidance,
)}\n`;
const libraryHash = createHash("sha256")
  .update(await readFile(libraryPath))
  .digest("hex");
const promptHash = createHash("sha256").update(prompt).digest("hex");

function replace(
  source: string,
  pattern: RegExp,
  value: string,
  label: string,
) {
  if (!pattern.test(source)) throw new Error(`missing ${label}`);
  return source.replace(pattern, `$1${value}$2`);
}

const files = {
  prompt: await readFile(outputPath, "utf8"),
  go: await readFile(goContractPath, "utf8"),
  store: await readFile(storePath, "utf8"),
  web: await readFile(webContractPath, "utf8"),
};
const next = {
  prompt,
  go: replace(
    replace(
      files.go,
      /(LibraryHash\s*=\s*")[a-f0-9]{64}(")/,
      libraryHash,
      "Go library hash",
    ),
    /(PromptHash\s*=\s*")[a-f0-9]{64}(")/,
    promptHash,
    "Go prompt hash",
  ),
  store: replace(
    files.store,
    /(customAppOpenUILibraryHash\s*=\s*")[a-f0-9]{64}(")/,
    libraryHash,
    "store library hash",
  ),
  web: replace(
    files.web,
    /(OPENUI_APP_LIBRARY_HASH\s*=\s*")[a-f0-9]{64}(")/,
    libraryHash,
    "web library hash",
  ),
};

if (process.argv.includes("--check")) {
  if (
    Object.keys(files).some(
      (key) =>
        files[key as keyof typeof files] !== next[key as keyof typeof next],
    )
  ) {
    console.error(
      "OpenUI App prompt is stale. Run: bun run generate:openui-app-prompt",
    );
    process.exit(1);
  }
  console.log("OpenUI App prompt is current");
} else {
  await Promise.all([
    writeFile(outputPath, next.prompt),
    writeFile(goContractPath, next.go),
    writeFile(storePath, next.store),
    writeFile(webContractPath, next.web),
  ]);
  console.log(`wrote ${prompt.length} characters to ${outputPath}`);
}
