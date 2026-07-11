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
const prompt = `${openUIAppLibrary.prompt(openUIAppPromptOptions)}\n`;
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
