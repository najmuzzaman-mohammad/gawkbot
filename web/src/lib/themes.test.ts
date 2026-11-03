import { describe, expect, it } from "vitest";

import {
  DEFAULT_DARK_THEME,
  DEFAULT_THEME,
  getTheme,
  isTheme,
  systemDefaultTheme,
  THEMES,
} from "./themes";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THEMES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/themes",
);

/** Files in public/themes that are shared layers, not selectable themes. */
const SHARED_LAYERS = new Set(["glass-base.css", "soft-base.css"]);

function themeCss(file: string): string {
  return readFileSync(join(THEMES_DIR, file), "utf8");
}

describe("theme registry", () => {
  it("defaults new installs to Glass, light then dark, leading the list", () => {
    expect(DEFAULT_THEME).toBe("nex-glass-light");
    expect(DEFAULT_DARK_THEME).toBe("nex-glass-dark");
    expect(THEMES[0].id).toBe(DEFAULT_THEME);
    expect(THEMES[1].id).toBe(DEFAULT_DARK_THEME);
  });

  it("follows the system appearance for a fresh install", () => {
    const original = window.matchMedia;
    const stub = (matches: boolean) =>
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (q: string) => ({
          matches: q.includes("dark") && matches,
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });
    try {
      stub(true);
      expect(systemDefaultTheme()).toBe("nex-glass-dark");
      stub(false);
      expect(systemDefaultTheme()).toBe("nex-glass-light");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: original,
      });
    }
  });

  it("ships both Soft flavours", () => {
    expect(isTheme("nex-soft-light")).toBe(true);
    expect(isTheme("nex-soft-dark")).toBe(true);
    expect(getTheme("nex-soft-light").name).toBe("Soft Light");
    expect(getTheme("nex-soft-dark").name).toBe("Soft Dark");
  });

  it("ships both Glass flavours", () => {
    expect(isTheme("nex-glass-dark")).toBe(true);
    expect(isTheme("nex-glass-light")).toBe(true);
    expect(getTheme("nex-glass-light").name).toBe("Glass Light");
  });

  it("keeps the themes users may already have persisted", () => {
    for (const id of [
      "nex-glass-dark",
      "nex-glass-light",
      "nex-shell",
      "nex",
      "nex-dark",
      "noir-gold",
    ]) {
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
      "nex-glass-light",
      "nex-glass-dark",
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
    // The base defines the material itself (the thicknesses, the light,
    // the tinted accents) from a few flavour tokens; only what it reads
    // and does not define must come from both flavours.
    for (const m of base.matchAll(/(--(?:glass|nex-sidebar)[\w-]*)\s*:/g)) {
      read.delete(m[1]);
    }
    // Coverage: the tint and the light on the glass are the flavour's job.
    for (const flavourOwned of [
      "--glass-tint",
      "--glass-sheen",
      "--glass-shade",
      "--glass-solid-card",
      "--glass-wash-3",
    ]) {
      expect(read.has(flavourOwned), `base reads ${flavourOwned}`).toBe(true);
    }
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

/** Selectors of every rule in a stylesheet, comments and at-rule heads out. */
function selectorsOf(css: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import[^;]*;/g, "")
    .split("}")
    .map((block) => block.split("{")[0].trim())
    .filter((sel) => sel && !sel.startsWith("@"))
    .flatMap((sel) => sel.split(","))
    .map((sel) => sel.trim())
    .filter(Boolean);
}

describe("Soft themes", () => {
  const base = themeCss("soft-base.css");

  it("resolves every display and pixel font token to the system stack", () => {
    expect(base).toMatch(/--font-sans:\s*-apple-system/);
    expect(base).toMatch(/--font-logo:\s*-apple-system/);
    expect(base).toContain("--font-pixel: var(--font-sans);");
  });

  it("scopes its shared layer to both flavours and nothing else", () => {
    const softIds = THEMES.filter((t) => t.id.startsWith("nex-soft"));
    expect(softIds.map((t) => t.id)).toEqual([
      "nex-soft-light",
      "nex-soft-dark",
    ]);
    const selectors = selectorsOf(base);
    // Coverage: a parse that found nothing would pass the check below.
    expect(selectors.length).toBeGreaterThan(60);
    const unscoped = selectors.filter(
      (sel) => !sel.startsWith('html[data-theme^="nex-soft"]'),
    );
    expect(unscoped).toEqual([]);
  });

  it("writes no literal colour in the shared layer", () => {
    const body = base
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@import[^;]*;/g, "");
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/rgba?\(/i);
  });

  it("defines the soft tokens the shared layer reads, in both flavours", () => {
    const read = new Set(
      Array.from(base.matchAll(/var\((--(?:soft|nex-sidebar)[\w-]*)/g)).map(
        (m) => m[1],
      ),
    );
    // Defined by the base itself (geometry, not colour).
    for (const own of [
      "--soft-bubble-radius",
      "--soft-bubble-tail",
      "--soft-bubble-max",
    ]) {
      expect(base).toMatch(new RegExp(`${own}:`));
      read.delete(own);
    }
    // Coverage: the bubbles, the field and the sidebar all read tokens.
    expect(read.size).toBeGreaterThanOrEqual(8);
    for (const file of ["nex-soft-light.css", "nex-soft-dark.css"]) {
      const css = themeCss(file);
      for (const token of read) {
        expect(css, `${file} defines ${token}`).toMatch(
          new RegExp(`${token}:`),
        );
      }
    }
  });

  it("lays bubbles out from attributes MessageBubble renders in every theme", () => {
    // The right-hand side keys off data-author-self, never a Soft-only class.
    expect(base).toContain(".message[data-author-self]");
    expect(base).not.toMatch(/\.message-mine|\.message-self\b/);
  });

  it("switches the empty-state hero on, as Glass does and no other", () => {
    const messages = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../styles/messages.css"),
      "utf8",
    );
    expect(messages).toMatch(
      /\.empty-hero\s*\{\s*display:\s*var\(--empty-hero-display,\s*none\);/,
    );
    const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
    expect(files.length).toBeGreaterThanOrEqual(THEMES.length);
    const setters = files.filter((f) =>
      /--empty-hero-display\s*:/.test(themeCss(f)),
    );
    expect(setters.sort()).toEqual(["glass-base.css", "soft-base.css"]);
  });
});
