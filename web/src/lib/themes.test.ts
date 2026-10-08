import { describe, expect, it } from "vitest";

import { DEFAULT_THEME, getTheme, isTheme, THEMES } from "./themes";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THEMES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/themes",
);

/** Files in public/themes that are shared layers, not selectable themes. */
const SHARED_LAYERS = new Set(["glass-base.css"]);

function themeCss(file: string): string {
  return readFileSync(join(THEMES_DIR, file), "utf8");
}

describe("theme registry", () => {
  it("defaults new installs to Glass Dark, which leads the list", () => {
    expect(DEFAULT_THEME).toBe("nex-glass-dark");
    expect(THEMES[0].id).toBe(DEFAULT_THEME);
  });

  it("ships both Glass flavours", () => {
    expect(isTheme("nex-glass-dark")).toBe(true);
    expect(isTheme("nex-glass-light")).toBe(true);
    expect(getTheme("nex-glass-light").name).toBe("Glass Light");
  });

  it("keeps the themes users may already have persisted", () => {
    for (const id of ["nex-shell", "nex", "nex-dark", "noir-gold"]) {
      expect(isTheme(id)).toBe(true);
    }
    expect(isTheme("not-a-theme")).toBe(false);
  });

  it("points every entry at a stylesheet that exists and scopes to its id", () => {
    for (const t of THEMES) {
      const file = t.cssPath.replace(/^\/themes\//, "");
      expect(t.cssPath).toBe(`/themes/${file}`);
      expect(themeCss(file)).toContain(`html[data-theme="${t.id}"]`);
    }
  });

  it("has a registry entry for every stylesheet that is not a shared layer", () => {
    const registered = new Set<string>(THEMES.map((t) => t.cssPath));
    const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
    // Coverage assertion: a directory listing that silently came back empty
    // would make the loop below pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(THEMES.length);
    for (const f of files) {
      if (SHARED_LAYERS.has(f)) continue;
      expect(registered.has(`/themes/${f}`)).toBe(true);
    }
  });
});

describe("Glass themes", () => {
  const base = themeCss("glass-base.css");

  it("resolves every display and pixel font token to the system stack", () => {
    expect(base).toMatch(/--font-sans:\s*-apple-system/);
    expect(base).toMatch(/--font-logo:\s*-apple-system/);
    expect(base).toContain("--font-pixel: var(--font-sans);");
  });

  it("scopes its shared layer to both flavours and nothing else", () => {
    // Both ids start with "nex-glass"; no other theme does.
    const glassIds = THEMES.filter((t) => t.id.startsWith("nex-glass"));
    expect(glassIds.map((t) => t.id)).toEqual([
      "nex-glass-dark",
      "nex-glass-light",
    ]);
    const selectors = base
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@import[^;]*;/g, "")
      .split("}")
      .map((block) => block.split("{")[0].trim())
      .filter((sel) => sel && !sel.startsWith("@"))
      .flatMap((sel) => sel.split(","))
      .map((sel) => sel.trim())
      .filter(Boolean);
    // Coverage: a parse that found nothing would pass the check below.
    expect(selectors.length).toBeGreaterThan(40);
    const unscoped = selectors.filter(
      (sel) => !sel.startsWith('html[data-theme^="nex-glass"]'),
    );
    expect(unscoped).toEqual([]);
  });

  it("defines the glass tokens the shared layer reads, in both flavours", () => {
    const read = new Set(
      Array.from(base.matchAll(/var\((--(?:glass|nex-sidebar)[\w-]*)/g)).map(
        (m) => m[1],
      ),
    );
    // Defined by the base itself.
    read.delete("--glass-blur");
    expect(read.size).toBeGreaterThan(0);
    for (const file of ["nex-glass-dark.css", "nex-glass-light.css"]) {
      const css = themeCss(file);
      for (const token of read) {
        expect(css, `${file} defines ${token}`).toMatch(
          new RegExp(`${token}:`),
        );
      }
    }
  });
});
