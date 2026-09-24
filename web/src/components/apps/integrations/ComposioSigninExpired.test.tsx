import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startComposioSignin = vi.fn();
const getComposioSigninStatus = vi.fn();
const cancelComposioSignin = vi.fn();

vi.mock("../../../api/integrations", async () => {
  const actual = await vi.importActual<
    typeof import("../../../api/integrations")
  >("../../../api/integrations");
  return {
    ...actual,
    startComposioSignin: (options?: { auto?: boolean }) =>
      startComposioSignin(options),
    getComposioSigninStatus: () => getComposioSigninStatus(),
    cancelComposioSignin: () => cancelComposioSignin(),
  };
});

import { ApiError } from "../../../api/client";
import {
  COMPOSIO_SIGNIN_EXPIRED,
  integrationErrorRequestId,
  isComposioSigninExpired,
} from "../../../api/integrations";
import { ComposioSigninExpired } from "./ComposioSigninExpired";

function renderPanel(props: Parameters<typeof ComposioSigninExpired>[0] = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ComposioSigninExpired {...props} />
    </QueryClientProvider>,
  );
}

// The exact broker envelope for a revoked credential, mirroring
// internal/team/broker_integrations.go. The request id is a placeholder.
const expiredBody = JSON.stringify({
  error: COMPOSIO_SIGNIN_EXPIRED,
  message:
    "Your Composio sign-in has expired. Sign in again to reconnect your apps.",
  request_id: "9466302c-0000-0000-0000-000000000000",
});

function expiredError(): ApiError {
  return new ApiError({
    status: 401,
    statusText: "Unauthorized",
    bodyText: expiredBody,
    errorCode: COMPOSIO_SIGNIN_EXPIRED,
    requestId: "9466302c-0000-0000-0000-000000000000",
  });
}

describe("composio sign-in expired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getComposioSigninStatus.mockResolvedValue({ status: "idle" });
    cancelComposioSignin.mockResolvedValue({ status: "idle" });
  });

  it("classifies the broker's expired-credential envelope", () => {
    const err = expiredError();
    expect(isComposioSigninExpired(err)).toBe(true);
    expect(integrationErrorRequestId(err)).toBe(
      "9466302c-0000-0000-0000-000000000000",
    );
    // A genuine upstream failure must NOT be mistaken for an expired sign-in.
    expect(
      isComposioSigninExpired(
        new ApiError({
          status: 502,
          statusText: "Bad Gateway",
          bodyText: "start composio connection: boom",
        }),
      ),
    ).toBe(false);
    expect(isComposioSigninExpired(new Error("offline"))).toBe(false);
  });

  it("renders the human sentence, not the protocol error", () => {
    renderPanel({ requestId: "9466302c-0000-0000-0000-000000000000" });
    const message = screen.getByRole("alert").textContent ?? "";
    expect(message).toBe(
      "Your Composio sign-in has expired. Sign in again to reconnect your apps.",
    );
    for (const banned of [
      "401",
      "Unauthorized",
      "UserApiKey_Unauthorized",
      "auth_configs",
      "composio API failed",
      "request_id",
    ]) {
      expect(message).not.toContain(banned);
    }
  });

  it("keeps the request id out of the sentence but available for support", () => {
    renderPanel({ requestId: "9466302c-0000-0000-0000-000000000000" });
    expect(screen.getByRole("alert").textContent).not.toContain("9466302c");
    // Behind a details affordance, collapsed by default.
    const details = screen.getByText("Details for support").closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(
      "9466302c-0000-0000-0000-000000000000",
    );
  });

  it("omits the details affordance when there is no request id", () => {
    renderPanel();
    expect(screen.queryByText("Details for support")).toBeNull();
  });

  it("starts the existing sign-in flow from the button", async () => {
    startComposioSignin.mockResolvedValue({
      status: "awaiting_login",
      auth_url: "https://platform.composio.dev/login?cliKey=abc",
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    renderPanel();

    await userEvent.click(
      screen.getByRole("button", { name: "Sign in again" }),
    );

    await waitFor(() => expect(startComposioSignin).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByText("Finish signing in in your browser"),
      ).toBeTruthy(),
    );
    expect(openSpy).toHaveBeenCalledWith(
      "https://platform.composio.dev/login?cliKey=abc",
      "_blank",
      "noopener",
    );
    openSpy.mockRestore();
  });

  it("tells the caller to retry once the sign-in lands", async () => {
    startComposioSignin.mockResolvedValue({ status: "provisioning" });
    getComposioSigninStatus.mockResolvedValue({ status: "done" });
    const onSignedIn = vi.fn();
    renderPanel({ onSignedIn });

    await userEvent.click(
      screen.getByRole("button", { name: "Sign in again" }),
    );
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });
});

// ── Automatic sign-in on a connect attempt ────────────────────────────────
// The founder's ask: "composio login should run automatically when logged out
// and attempting to connect something via it." A panel that is here BECAUSE a
// connect failed must start the sign-in itself, show it happening, let the user
// stop it, and then resume the connect they asked for.
describe("composio sign-in starts automatically on a connect attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getComposioSigninStatus.mockResolvedValue({ status: "awaiting_login" });
  });

  it("starts the flow with no click, and marks it as automatic", async () => {
    startComposioSignin.mockResolvedValue({
      status: "awaiting_login",
      auth_url: "https://platform.composio.dev/login?cliKey=auto",
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    renderPanel({ autoStart: true });

    await waitFor(() => expect(startComposioSignin).toHaveBeenCalledTimes(1));
    expect(startComposioSignin).toHaveBeenCalledWith({ auto: true });
    await waitFor(() =>
      expect(
        screen.getByText("Finish signing in in your browser"),
      ).toBeTruthy(),
    );
    openSpy.mockRestore();
  });

  it("shows the link and a way to copy it, because a popup may be blocked", async () => {
    startComposioSignin.mockResolvedValue({
      status: "awaiting_login",
      auth_url: "https://platform.composio.dev/login?cliKey=auto",
    });
    vi.spyOn(window, "open").mockReturnValue(null);
    renderPanel({ autoStart: true });

    const link = await screen.findByRole("link", {
      name: /open the sign-in page/i,
    });
    expect(link.getAttribute("href")).toBe(
      "https://platform.composio.dev/login?cliKey=auto",
    );
    // The URL itself is visible and copyable for a browser that never opened.
    expect(
      screen.getByText("https://platform.composio.dev/login?cliKey=auto"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("can be stopped, and does not start again by itself", async () => {
    startComposioSignin.mockResolvedValue({
      status: "awaiting_login",
      auth_url: "https://platform.composio.dev/login?cliKey=auto",
    });
    vi.spyOn(window, "open").mockReturnValue(null);
    renderPanel({ autoStart: true });

    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await userEvent.click(cancel);

    // Back to the explicit button, and no second automatic start.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sign in again" }),
      ).toBeTruthy(),
    );
    expect(cancelComposioSignin).toHaveBeenCalledTimes(1);
    expect(startComposioSignin).toHaveBeenCalledTimes(1);
  });

  it("asks before installing anything when the helper is missing", async () => {
    startComposioSignin.mockResolvedValue({
      status: "install_required",
      install_command: "curl -fsSL https://example.test/install.sh | bash",
    });
    renderPanel({ autoStart: true });

    const confirm = await screen.findByRole("button", { name: "Set it up" });
    // Nothing has been installed yet: the only call so far is the automatic
    // start that stopped to ask.
    expect(startComposioSignin).toHaveBeenCalledTimes(1);
    expect(startComposioSignin).toHaveBeenCalledWith({ auto: true });
    // The shell command is never in the prose the operator reads.
    const prose = Array.from(screen.getByRole("status").querySelectorAll("p"))
      .map((node) => node.textContent ?? "")
      .join(" ");
    expect(prose).toContain("small helper installed on this computer");
    expect(prose).not.toContain("curl");
    expect(prose).not.toContain("bash");
    // It is available to whoever can act on it, collapsed by default.
    const details = screen
      .getByText("For whoever set up this computer")
      .closest("details");
    expect(details?.open).toBe(false);

    await userEvent.click(confirm);
    // The yes is an explicit start — that consent is what permits the install.
    await waitFor(() => expect(startComposioSignin).toHaveBeenCalledTimes(2));
    expect(startComposioSignin).toHaveBeenLastCalledWith({ auto: false });
  });

  it("falls back to the button when the broker declines to start another", async () => {
    startComposioSignin.mockResolvedValue({ status: "idle" });
    renderPanel({ autoStart: true });

    await waitFor(() => expect(startComposioSignin).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("button", { name: "Sign in again" }),
    ).toBeTruthy();
  });

  it("resumes the original connect once the sign-in lands", async () => {
    startComposioSignin.mockResolvedValue({ status: "provisioning" });
    getComposioSigninStatus.mockResolvedValue({ status: "done" });
    const onSignedIn = vi.fn();
    renderPanel({ autoStart: true, onSignedIn });

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it("says a sign-in is under way while it is, and not before", async () => {
    startComposioSignin.mockResolvedValue({ status: "idle" });
    const { unmount } = renderPanel({ autoStart: true, neverSignedIn: true });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "You are not signed in to Composio yet. Sign in to connect this app.",
      ),
    );
    unmount();

    startComposioSignin.mockResolvedValue({ status: "provisioning" });
    getComposioSigninStatus.mockResolvedValue({ status: "provisioning" });
    renderPanel({ autoStart: true, neverSignedIn: true });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "You are not signed in to Composio yet. Signing you in now.",
      ),
    );
  });

  it("keeps every operator sentence free of protocol debris", async () => {
    startComposioSignin.mockResolvedValue({
      status: "awaiting_login",
      auth_url: "https://platform.composio.dev/login?cliKey=auto",
    });
    vi.spyOn(window, "open").mockReturnValue(null);
    renderPanel({
      autoStart: true,
      requestId: "9466302c-0000-0000-0000-000000000000",
    });
    await screen.findByText("Finish signing in in your browser");

    // Everything except the two disclosures addressed at support/whoever set
    // this computer up, and the copyable link itself.
    const prose = [
      screen.getByRole("alert").textContent ?? "",
      ...Array.from(document.querySelectorAll("p")).map(
        (node) => node.textContent ?? "",
      ),
    ].join(" ");
    for (const banned of [
      "401",
      "composio login",
      "composio dev init",
      "curl",
      "COMPOSIO_API_KEY",
      "UserApiKey_Unauthorized",
      "request_id",
      "9466302c",
      "uak_",
      "ak_",
    ]) {
      expect(prose).not.toContain(banned);
    }
  });
});
