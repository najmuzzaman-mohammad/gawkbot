import {
  openUIArtifactLibrary,
  openUIArtifactPromptOptions,
} from "../src/lib/openUIArtifactLibrary";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputPath = resolve(
  import.meta.dir,
  "../../internal/openuiartifact/system_prompt.txt",
);
const prompt = `${openUIArtifactLibrary.prompt(openUIArtifactPromptOptions)}\n`;
const librarySourcePath = resolve(
  import.meta.dir,
  "../src/lib/openUIArtifactLibrary.tsx",
);
const libraryHash = createHash("sha256")
  .update(await readFile(librarySourcePath))
  .digest("hex");
const promptHash = createHash("sha256").update(prompt).digest("hex");
const goContractPath = resolve(
  import.meta.dir,
  "../../internal/openuiartifact/prompt.go",
);
const webContractPath = resolve(import.meta.dir, "../src/api/richArtifacts.ts");

function replaceGoHash(source: string, name: string, hash: string) {
  const pattern = new RegExp(`(${name}\\s*=\\s*")[a-f0-9]{64}(")`);
  if (!pattern.test(source)) {
    throw new Error(`missing ${name} hash constant`);
  }
  return source.replace(pattern, `$1${hash}$2`);
}

function extractHash(source: string, pattern: RegExp, name: string) {
  const value = source.match(pattern)?.[1];
  if (!value) throw new Error(`missing ${name} hash constant`);
  return value;
}

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== prompt) {
    console.error(
      "OpenUI artifact prompt is stale. Run: bun run generate:openui-artifact-prompt",
    );
    process.exit(1);
  }
  const goContract = await readFile(goContractPath, "utf8");
  const webContract = await readFile(webContractPath, "utf8");
  const goLibraryHash = extractHash(
    goContract,
    /LibraryHash\s*=\s*"([a-f0-9]{64})"/,
    "Go LibraryHash",
  );
  const goPromptHash = extractHash(
    goContract,
    /PromptHash\s*=\s*"([a-f0-9]{64})"/,
    "Go PromptHash",
  );
  const webLibraryHash = extractHash(
    webContract,
    /OPENUI_ARTIFACT_LIBRARY_HASH\s*=\s*\n?\s*"([a-f0-9]{64})"/,
    "web library hash",
  );
  if (
    goLibraryHash !== libraryHash ||
    webLibraryHash !== libraryHash ||
    goPromptHash !== promptHash
  ) {
    console.error(
      "OpenUI prompt or executable library hashes are stale. Run: bun run generate:openui-artifact-prompt",
    );
    process.exit(1);
  }
  console.log("OpenUI artifact prompt is current");
} else {
  await writeFile(outputPath, prompt, "utf8");
  let goContract = await readFile(goContractPath, "utf8");
  goContract = replaceGoHash(goContract, "LibraryHash", libraryHash);
  goContract = replaceGoHash(goContract, "PromptHash", promptHash);
  await writeFile(goContractPath, goContract, "utf8");
  const webContract = await readFile(webContractPath, "utf8");
  const updatedWebContract = webContract.replace(
    /(OPENUI_ARTIFACT_LIBRARY_HASH\s*=\s*\n?\s*")[a-f0-9]{64}(")/,
    `$1${libraryHash}$2`,
  );
  await writeFile(webContractPath, updatedWebContract, "utf8");
  console.log(`wrote ${prompt.length} characters to ${outputPath}`);
}
