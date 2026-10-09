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
    id: "nex-glass-light",
    name: "Glass Light",
    desc: "Native light, frosted glass.",
    swatch: { primary: "#f2f2f5", accent: "#1c1c1e", surface: "#ffffff" },
    cssPath: "/themes/nex-glass-light.css",
  },
  {
    id: "nex-glass-dark",
    name: "Glass Dark",
    desc: "Native dark, frosted glass.",
    swatch: { primary: "#1c1c1f", accent: "#f5f5f7", surface: "#111113" },
    cssPath: "/themes/nex-glass-dark.css",
  },
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
 * What a fresh install renders: Glass, in the flavour that matches the
 * system appearance (see `systemDefaultTheme`). Only read when nothing is
 * persisted under `wuphf-theme` (see stores/app.ts), so changing it never
 * moves a user who already picked a theme.
 */
export const DEFAULT_THEME: Theme = "nex-glass-light";

/** The Glass flavour for a dark system appearance. */
export const DEFAULT_DARK_THEME: Theme = "nex-glass-dark";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/**
 * The theme a fresh install gets right now: Glass Dark when the system is
 * in dark mode, Glass Light otherwise. A Mac app follows the system
 * appearance until the person picks a theme of their own.
 */
export function systemDefaultTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return DEFAULT_THEME;
  return window.matchMedia(DARK_SCHEME_QUERY).matches
    ? DEFAULT_DARK_THEME
    : DEFAULT_THEME;
}

/**
 * Calls `onChange` with the new system default whenever the system
 * appearance flips. Returns the unsubscribe. A no-op where matchMedia is
 * missing (tests, SSR).
 */
export function watchSystemAppearance(
  onChange: (theme: Theme) => void,
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => {};
  const query = window.matchMedia(DARK_SCHEME_QUERY);
  const handler = (e: MediaQueryListEvent) =>
    onChange(e.matches ? DEFAULT_DARK_THEME : DEFAULT_THEME);
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

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
