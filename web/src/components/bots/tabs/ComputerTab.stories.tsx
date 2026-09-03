import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { OfficeMember } from "../../../api/client";
import { useAppStore } from "../../../stores/app";
import { ComputerTab } from "./ComputerTab";

/**
 * The bot's own computer, and you can watch. Every phase of the tab from a
 * stubbed broker: `window.fetch` answers the computer routes and `/config`,
 * so the stories are interactive (Take control, Sleep, the console) without
 * a real container. Wire shapes follow docs/specs/gawkbot-bot-computers.md.
 */
const meta: Meta<typeof ComputerTab> = {
  title: "Features/Agents/ComputerTab",
  component: ComputerTab,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ComputerTab>;

const BOT: OfficeMember = {
  slug: "growth",
  name: "Growth Lead",
  role: "Demand generation and pipeline",
  status: "active",
  task: "File the three invoices into Xero",
};

// A stand-in desktop: a dark XFCE-ish frame drawn as SVG so the story has a
// picture without shipping a JPEG. Real frames arrive as data URLs too.
const FRAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
  <rect width="1280" height="800" fill="#2b2f3a"/>
  <rect x="0" y="0" width="1280" height="28" fill="#1c1f27"/>
  <text x="14" y="19" font-family="sans-serif" font-size="13" fill="#c8ccd6">Applications  Places</text>
  <rect x="120" y="90" width="1040" height="620" rx="8" fill="#f4f5f7"/>
  <rect x="120" y="90" width="1040" height="40" rx="8" fill="#e2e4e9"/>
  <text x="140" y="116" font-family="sans-serif" font-size="14" fill="#333">Xero — Bills to pay</text>
  <rect x="160" y="170" width="960" height="1" fill="#d5d8de"/>
  <text x="160" y="200" font-family="sans-serif" font-size="16" fill="#222">Invoice #1042 · Northwind Traders · $1,240.00</text>
  <text x="160" y="240" font-family="sans-serif" font-size="16" fill="#222">Invoice #1043 · Globex · $980.00</text>
  <text x="160" y="280" font-family="sans-serif" font-size="16" fill="#222">Invoice #1044 · Initech · $2,310.50</text>
  <rect x="160" y="330" width="140" height="36" rx="6" fill="#4d6bfe"/>
  <text x="180" y="354" font-family="sans-serif" font-size="14" fill="#fff">Approve all</text>
</svg>`;
const FRAME_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(FRAME_SVG)}`;

const VIEWER_HTML = `<!doctype html><html><body style="margin:0;background:#2b2f3a;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#c8ccd6"><div style="text-align:center"><div style="font-size:14px;margin-bottom:6px">noVNC · live desktop</div><div style="font-size:11px;opacity:.7">stubbed viewer for Storybook</div></div></body></html>`;
const VIEWER_DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(VIEWER_HTML)}`;

interface Scenario {
  state: string;
  destination?: "off" | "sandbox" | "cloud";
  problem?: string | null;
  busy?: boolean;
  viewer?: boolean;
  frame?: boolean;
  held?: boolean;
  helpReason?: string | null;
  boxKeySet?: boolean;
  installHint?: string;
  buildLines?: string[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function statusBody(s: Scenario) {
  return {
    slug: BOT.slug,
    destination: s.destination ?? "sandbox",
    cloud_backend: "box",
    state: s.state,
    problem: s.problem ?? null,
    busy: s.busy ?? false,
    viewer_url: s.viewer ? VIEWER_DATA_URL : null,
    control: { held: s.held ?? false, help_reason: s.helpReason ?? null },
    last_frame: s.frame ? { data_url: FRAME_DATA_URL, at: 1 } : null,
    container_name: "gawkbot-computer-3f2a9c1b7d4e6f08",
    workspace_dir: "~/.gawkbot/computers/3f2a9c1b7d4e6f08",
    box: null,
  };
}

function runtimeBody(scenario: Scenario) {
  return {
    available: scenario.state !== "runtime_missing",
    runtime: scenario.state === "runtime_missing" ? "" : "docker",
    daemon_up: true,
    image: scenario.state === "ready",
    image_ref: "gawkbot/computer:cua-0.20.0",
    driver_version: "0.20.0",
    building: scenario.state === "building",
    install_hint: scenario.installHint ?? "",
    runtime_start_hint: "",
    problem: "",
  };
}

/** Mutations against the per-bot computer; returns the response body. */
function handleComputerPost(
  scenario: Scenario,
  path: string,
  body: { action?: string },
): unknown {
  if (path.endsWith("/control")) {
    if (body.action === "take") {
      scenario.held = true;
      scenario.helpReason = null;
    }
    if (body.action === "release") scenario.held = false;
    if (body.action === "dismiss-help") scenario.helpReason = null;
    return {
      held: scenario.held ?? false,
      help_reason: scenario.helpReason ?? null,
    };
  }
  if (path.endsWith("/join")) {
    scenario.held = true;
    return { viewer_url: VIEWER_DATA_URL };
  }
  if (path.endsWith("/exec")) {
    return { exit_code: 0, stdout: "invoices/\nxero-login.txt\n", stderr: "" };
  }
  if (path.endsWith("/sleep")) scenario.state = "asleep";
  if (path.endsWith("/start") || path.endsWith("/provision")) {
    scenario.state = "ready";
    scenario.viewer = true;
  }
  if (path.endsWith("/remove")) scenario.state = "missing";
  return statusBody(scenario);
}

function answer(
  scenario: Scenario,
  path: string,
  method: string,
  rawBody: BodyInit | null | undefined,
): unknown {
  if (path.endsWith("/config")) {
    return { box_key_set: scenario.boxKeySet ?? false };
  }
  if (path.endsWith("/computer/runtime")) return runtimeBody(scenario);
  if (path.endsWith("/computer/runtime/prepare")) {
    scenario.state = "building";
    return { building: true };
  }
  if (path.includes("/computer/growth")) {
    if (method !== "POST") return statusBody(scenario);
    const body = rawBody ? JSON.parse(String(rawBody)) : {};
    return handleComputerPost(scenario, path, body);
  }
  return {};
}

/** Stub the broker. Control actions mutate the scenario so buttons work. */
function useBrokerStub(initial: Scenario): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const scenario: Scenario = { ...initial };
    const original = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input.toString(),
        window.location.origin,
      );
      return jsonResponse(
        answer(scenario, url.pathname, init?.method ?? "GET", init?.body),
      );
    }) as typeof window.fetch;
    setReady(true);
    return () => {
      window.fetch = original;
    };
  }, [initial]);
  return ready;
}

function seedBuildLog(lines: string[]) {
  useAppStore.setState({
    computerRuntimeBuild: { building: true, problem: null, lines },
  });
}

function Harness({
  scenario,
  agent = BOT,
}: {
  scenario: Scenario;
  agent?: OfficeMember;
}) {
  const ready = useBrokerStub(scenario);
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
  );
  useEffect(() => {
    useAppStore.setState({ computerStates: {} });
    if (scenario.buildLines) seedBuildLog(scenario.buildLines);
    else {
      useAppStore.setState({
        computerRuntimeBuild: { building: false, problem: null, lines: [] },
      });
    }
  }, [scenario]);
  if (!ready) return null;
  return (
    <QueryClientProvider client={client}>
      <div
        className="bot-subspace"
        style={{ height: 720, width: "min(960px, 100vw)" }}
      >
        <div className="bot-subspace-panel">
          <ComputerTab agent={agent} />
        </div>
      </div>
    </QueryClientProvider>
  );
}

/** The bot's computer is off. The Runs on card is the only lever. */
export const Off: Story = {
  render: () => (
    <Harness
      scenario={{ state: "off", destination: "off" }}
      agent={{ ...BOT, computer: "off" }}
    />
  ),
};

/** Priya's path: no runtime on this Mac, cloud and install side by side. */
export const RuntimeMissing: Story = {
  render: () => (
    <Harness
      scenario={{
        state: "runtime_missing",
        installHint:
          "No docker, podman, or container CLI found. OrbStack installs docker in one step.",
      }}
    />
  ),
};

/** A Box key is already saved; the field reads as set. */
export const RuntimeMissingWithBoxKey: Story = {
  render: () => (
    <Harness scenario={{ state: "runtime_missing", boxKeySet: true }} />
  ),
};

/** Cloud picked, no key yet. */
export const Unconfigured: Story = {
  render: () => (
    <Harness
      scenario={{ state: "unconfigured", destination: "cloud" }}
      agent={{ ...BOT, computer: "cloud" }}
    />
  ),
};

/** Runtime found, shared image not built. One button. */
export const ImageMissing: Story = {
  render: () => <Harness scenario={{ state: "image_missing" }} />,
};

/** Sam's first run: the build streams progress lines. */
export const Building: Story = {
  render: () => (
    <Harness
      scenario={{
        state: "building",
        buildLines: [
          "Pulling docker.io/trycua/xfce-cua@sha256:9f2c…",
          "Step 2/9: install cua-driver 0.20.0",
          "Step 3/9: supervisord entry",
          "Step 4/9: workspace mount",
        ],
      }}
    />
  ),
};

/** Image ready, this bot has no container yet. */
export const Missing: Story = {
  render: () => <Harness scenario={{ state: "missing" }} />,
};

export const Provisioning: Story = {
  render: () => <Harness scenario={{ state: "provisioning" }} />,
};

/** Live desktop through the signed noVNC page, view policy. */
export const ReadyLive: Story = {
  render: () => <Harness scenario={{ state: "ready", viewer: true }} />,
};

/** No viewer URL (expired or headless): the last settled frame. */
export const ReadyFrame: Story = {
  render: () => <Harness scenario={{ state: "ready", frame: true }} />,
};

/** The bot asked for hands. Take control or dismiss. */
export const HelpRequested: Story = {
  render: () => (
    <Harness
      scenario={{
        state: "ready",
        viewer: true,
        helpReason:
          "Xero is asking for a login and I do not have the password.",
      }}
    />
  ),
};

/** You have the wheel. */
export const Held: Story = {
  render: () => (
    <Harness scenario={{ state: "ready", viewer: true, held: true }} />
  ),
};

/** A cloud desktop: no delete button, "cloud" label. */
export const ReadyCloud: Story = {
  render: () => (
    <Harness
      scenario={{ state: "ready", viewer: true, destination: "cloud" }}
      agent={{ ...BOT, computer: "cloud" }}
    />
  ),
};

/** Asleep after ten idle minutes, last frame dimmed behind Start. */
export const Asleep: Story = {
  render: () => <Harness scenario={{ state: "asleep", frame: true }} />,
};

/** The verifier refused a tampered container. Honest, with the reason. */
export const ErrorState: Story = {
  render: () => (
    <Harness
      scenario={{
        state: "error",
        problem:
          "refusing container gawkbot-computer-3f2a9c1b: published port 6901 on 0.0.0.0",
      }}
    />
  ),
};
