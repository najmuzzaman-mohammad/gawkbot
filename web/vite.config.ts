/// <reference types="vitest" />

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The broker web server the dev proxy forwards /api to. Defaults to the standard
// :7891, but is overridable so a worktree can run its own broker on dedicated
// ports and never collide with another worktree's broker on the default ports.
// Set WUPHF_WEB_PROXY_TARGET (e.g. http://127.0.0.1:7893) or just
// WUPHF_WEB_PROXY_PORT (e.g. 7893).
const proxyTarget =
  process.env.WUPHF_WEB_PROXY_TARGET ||
  `http://127.0.0.1:${process.env.WUPHF_WEB_PROXY_PORT || "7891"}`;

const proxyEntry = { target: proxyTarget, changeOrigin: true };

// The pi-mono build bot (bot/ service). Its /tools/build endpoint authors the
// tools the app's chat calls. Overridable so a worktree can point at its own
// bot; defaults to the bot dev port (8820). The /bot prefix is stripped so
// the service sees /tools/build.
const botTarget =
  process.env.WUPHF_AGENT_TARGET ||
  `http://127.0.0.1:${process.env.WUPHF_AGENT_PORT || "8820"}`;
const botEntry = {
  target: botTarget,
  changeOrigin: true,
  rewrite: (p: string) => p.replace(/^\/agent/, ""),
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["canonicalize"],
  },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": proxyEntry,
      "/api-token": proxyEntry,
      "/onboarding": proxyEntry,
      // Anchored regex, NOT the bare "/bot" string. Vite proxy keys are
      // prefix matches, so "/bot" also swallowed "/bots" — the app's
      // own route — and hitting http://localhost:PORT/bots in dev
      // returned the bot service's {"error":"not found"} instead of the
      // SPA. Production was always fine (the Go server serves the SPA for
      // unknown paths), so this only ever broke dev, quietly.
      // The lookahead keeps /bot and /bot/... matching while leaving
      // /bots, /bot-logs and friends to the SPA fallback.
      "^/agent(?=/|$)": botEntry,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "happy-dom",
    globals: true,
    // Same failure family as the stubbed `fetch` and the disabled
    // `EventSource` in tests/setup.ts: a handle that outlives the test and
    // keeps the worker pool alive. Those two cover the global fetch and SSE
    // paths, but happy-dom loads SUBRESOURCES through its own internal HTTP
    // client, which neither stub can reach. An <iframe src="http://..."> is
    // therefore a real socket. CustomAppFrame.sandbox.test.tsx renders one
    // pointing at localhost:5599 purely to assert the `sandbox` attribute —
    // it never needs the frame to load — and with nothing listening there
    // the connection kept the pool open. The file passed alone and stalled
    // the full run, which is what made "the suite is green" unverifiable.
    // Turned off at the environment level rather than in the test so the
    // next iframe/script/stylesheet test cannot reintroduce it.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableIframePageLoading: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
        },
      },
    },
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Hard timeouts so a runaway test/teardown fails the suite instead of
    // hanging the CI worker for 15+ minutes. We've hit this via SSE/timer
    // handles that outlive a test.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: [
        "src/components/wiki/**",
        "src/lib/wikilink.ts",
        "src/api/wiki.ts",
      ],
      // The refclone editor is a large embedded editor surface with its own
      // coverage ramp; keep the legacy wiki gate scoped to the current baseline.
      exclude: ["src/components/wiki/editor/refclone/**"],
      // Current scoped wiki baseline. Ratchet these upward as coverage improves
      // instead of letting the CI gate start red.
      thresholds: { statements: 70, lines: 73, branches: 64, functions: 71 },
    },
  },
});
