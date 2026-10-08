/**
 * Theme registry — single source of truth for every theme the app ships.
 *
 * Adding a theme means:
 *   1. Drop the CSS file under `web/public/themes/<id>.css`.
 *   2. Append an entry to `THEMES` below.
 *
 * Not every file in `public/themes/` is a theme: `soft-base.css` and
 * `glass-base.css` are the shared layers each pair of flavours imports, the
 * way the nex-* themes import `nex.css`. The default theme leads the list.
 *
 * The `Theme` union, the switcher menu, and the loader in `RootRoute` all
 * derive their behaviour from this list.
 */

export interface ThemeSwatch {
  /** Dominant chrome color used for the half of the corner badge. */
  primary: string;
  /** Accent color used for the other half of the corner badge. */
  accent: string;
  /** Body surface color, used as the swatch border so it reads against any bg. */
  surface: string;
}

export interface ThemeDef {
  id: string;
  name: string;
  desc: string;
  swatch: ThemeSwatch;
  /** Public path served by Vite — loaded into a `<link>` tag at runtime. */
  cssPath: string;
}

export const THEMES = [
  {
    id: "nex-soft-light",
    name: "Soft Light",
    desc: "Friendly chat bubbles, bright and airy.",
    swatch: { primary: "#f6f7f8", accent: "#0e7a41", surface: "#fcfcfd" },
    cssPath: "/themes/nex-soft-light.css",
  },
  {
    id: "nex-soft-dark",
    name: "Soft Dark",
    desc: "Friendly chat bubbles, after hours.",
    swatch: { primary: "#131417", accent: "#34d17a", surface: "#0e0f11" },
    cssPath: "/themes/nex-soft-dark.css",
  },
  {
    id: "nex-glass-dark",
    name: "Glass Dark",
    desc: "Native dark, frosted glass.",
    swatch: { primary: "#1c1c1f", accent: "#30d158", surface: "#111113" },
    cssPath: "/themes/nex-glass-dark.css",
  },
  {
    id: "nex-glass-light",
    name: "Glass Light",
    desc: "Native light, frosted glass.",
    swatch: { primary: "#f2f2f5", accent: "#1a7f3c", surface: "#ffffff" },
    cssPath: "/themes/nex-glass-light.css",
  },
  {
    id: "nex-shell",
    name: "Shell",
    desc: "The dark technical manual.",
    swatch: { primary: "#131516", accent: "#93a5f0", surface: "#18191b" },
    cssPath: "/themes/nex-shell.css",
  },
  {
    id: "nex",
    name: "Light",
    desc: "Clean light. Purple accent.",
    swatch: { primary: "#612a92", accent: "#9f4dbf", surface: "#ffffff" },
    cssPath: "/themes/nex.css",
  },
  {
    id: "nex-dark",
    name: "Dark",
    desc: "Low-glare dark.",
    swatch: { primary: "#0f0f12", accent: "#9f4dbf", surface: "#1a1a1f" },
    cssPath: "/themes/nex-dark.css",
  },
  {
    id: "noir-gold",
    name: "Noir Gold",
    desc: "Black, gold leaf.",
    swatch: { primary: "#0a0a0a", accent: "#d4af37", surface: "#161616" },
    cssPath: "/themes/noir-gold.css",
  },
] as const satisfies readonly ThemeDef[];

export type Theme = (typeof THEMES)[number]["id"];

/**
 * What a fresh install renders. Only read when nothing is persisted under
 * `wuphf-theme` (see stores/app.ts), so changing it never moves a user who
 * already picked a theme.
 */
export const DEFAULT_THEME: Theme = "nex-soft-light";

const THEME_IDS: ReadonlySet<string> = new Set(THEMES.map((t) => t.id));

/** Type guard for unknown values that might be persisted theme ids. */
export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && THEME_IDS.has(v);
}

/** Resolve a theme id to its definition, falling back to the default. */
export function getTheme(id: Theme): (typeof THEMES)[number] {
  const found = THEMES.find((t) => t.id === id);
  if (found) return found;
  // Manifest is non-empty and `id` is a member of the union, so this branch
  // is unreachable in practice; the explicit fallback keeps the return type
  // narrow for callers.
  return THEMES[0];
}
