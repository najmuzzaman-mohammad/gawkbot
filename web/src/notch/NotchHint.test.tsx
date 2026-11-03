import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationConnectResult } from "../api/integrations";
import type { NativeMessage } from "./bridge";
import { NotchHint } from "./NotchHint";
import type { NotchHint as NotchHintData } from "./types";

// The hint, talking to a broker the test controls and a stand-in for the
// Mac app: Connect opens the sign-in page in the browser and waits for the
// connection to land; Not now sends it away and tells the broker.

const marked: string[] = [];
const dismissed: string[] = [];
let started: IntegrationConnectResult | Error = {
  provider: "composio",
  platform: "gmail",
  status: "pending",
  auth_url: "https://connect.example/gmail",
  connect_id: "c1",
};
let statusNow = "pending";

vi.mock("./hintApi", async (original) => {
  const real = await original<typeof import("./hintApi")>();
  return {
    ...real,
    markHintSeen: (p: string) => {
      marked.push(p);
      return Promise.resolve();
    },
    dismissHint: (p: string) => {
      dismissed.push(p);
      return Promise.resolve();
    },
    connectFromHint: (p: string) => {
      if (started instanceof Error) return Promise.reject(started);
      real.openInBrowser(started.auth_url ?? "");
      return Promise.resolve({ ...started, platform: p });
    },
    hintConnectStatus: (p: string) =>
      Promise.resolve({ provider: "composio", platform: p, status: statusNow }),
  };
});

type NotchHost = { webkit?: unknown };
let posted: NativeMessage[] = [];

const GMAIL: NotchHintData = {
  platform: "gmail",
  name: "Gmail",
  line: "Connect Gmail so your bots can read this inbox",
  since: "2026-10-15T09:00:00Z",
};

function mount(onOpen = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NotchHint hint={GMAIL} onOpen={onOpen} />
    </QueryClientProvider>,
  );
  return onOpen;
}

beforeEach(() => {
  posted = [];
  marked.length = 0;
  dismissed.length = 0;
  statusNow = "pending";
  (window as unknown as NotchHost).webkit = {
    messageHandlers: {
      gawkNotch: { postMessage: (m: NativeMessage) => posted.push(m) },
    },
  };
});

afterEach(() => {
  cleanup();
  (window as unknown as NotchHost).webkit = undefined;
});

describe("the integration hint", () => {
  it("says the line once, counts itself as seen, and goes away on Not now", async () => {
    mount();
    expect(screen.getByText(GMAIL.line)).toBeInTheDocument();
    await waitFor(() => expect(marked).toEqual(["gmail"]));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("notch-hint")).toBeNull();
    expect(dismissed).toEqual(["gmail"]);
  });

  it("opens the sign-in page in the browser through the app and waits for it to land", async () => {
    mount();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(posted).toContainEqual({
        type: "browse",
        url: "https://connect.example/gmail",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Waiting for the browser…" }),
    ).toBeDisabled();
    statusNow = "connected";
    await waitFor(
      () => expect(screen.getByText("Gmail connected.")).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );
  });

  it("sends the person to the full view when the office is not signed in", async () => {
    started = new Error("composio_signin_needed");
    const onOpen = mount();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith("/apps/integrations"),
    );
  });

  it("sends the person to the full view when the platform needs typed credentials", async () => {
    started = {
      provider: "composio",
      platform: "jira",
      status: "needs_fields",
    };
    const onOpen = mount();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith("/apps/integrations"),
    );
  });
});
