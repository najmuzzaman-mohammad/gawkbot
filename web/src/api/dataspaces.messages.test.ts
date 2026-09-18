import { describe, expect, it } from "vitest";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Same walk-up as dataspaces.contract.test.ts: import.meta.url is not a file
// URL under the Vite transform, so locate the directory from the cwd instead.
const RELATIVE_PATH = "web/src/api";

function apiDir(): string {
  let directory = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(directory, RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(
    `${RELATIVE_PATH} not found above ${process.cwd()}; this test sweeps the mock's messages.`,
  );
}

/**
 * An error message from the store is read by two audiences who share no
 * vocabulary: a bot, whose tools are named `data_link_records` and
 * `data_update_record`, and the operator, to whom any function name is noise.
 * Neither can act on "Use linkRecords".
 *
 * The Go store carries the same guard (TestMessagesDoNotNameStoreMethods in
 * internal/dataspace). This is its mirror, because the mock is the behaviour
 * oracle and the two drifted once already: Go was corrected while the mock kept
 * naming its own functions.
 */
const FORBIDDEN = [
  "linkRecords",
  "unlinkRecords",
  "updateRecord",
  "createRecord",
  "upsertRecords",
  "queryRecords",
  "getSchema",
  "previewDelete",
  "executeDelete",
  "updateSpaceAccess",
];

// Derived from disk, not hardcoded: a hardcoded list silently stops covering
// a file that gets added, and names one that gets removed (which is how this
// test first went red — on a filename that never existed, not on a message).
function mockFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(
      (name) =>
        (name.startsWith("dataspaces.mock") ||
          name.startsWith("dataspacesAccess")) &&
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".testkit.ts"),
    )
    .sort();
}

/** Template literals and plain strings that read like a sentence to a human. */
function sentenceLiterals(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/`([^`]*)`|"([^"]*)"/g)) {
    const text = match[1] ?? match[2] ?? "";
    // A sentence ends in punctuation and has spaces; an identifier or a path
    // has neither, which keeps imports and slugs out of the sweep.
    if (/[.!?]$/.test(text.trim()) && text.includes(" ")) out.push(text);
  }
  return out;
}

describe("store messages never name a function the caller cannot call", () => {
  const dir = apiDir();
  const files = mockFiles(dir);

  it("sweeps every mock source file", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(mockFiles(apiDir()))("%s", (file) => {
    const source = readFileSync(join(dir, file), "utf8");
    const offenders: string[] = [];
    for (const sentence of sentenceLiterals(source)) {
      for (const name of FORBIDDEN) {
        if (sentence.includes(name)) offenders.push(`${name}: ${sentence}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually catches a message that names one", () => {
    const planted = '`"firm" is a relationship. Use linkRecords to set it.`';
    const found = sentenceLiterals(planted).some((s) =>
      FORBIDDEN.some((n) => s.includes(n)),
    );
    expect(found).toBe(true);
  });
});
