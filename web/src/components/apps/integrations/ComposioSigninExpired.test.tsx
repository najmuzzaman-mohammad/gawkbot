import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startComposioSignin = vi.fn();
const getComposioSigninStatus = vi.fn();

vi.mock("../../../api/integrations", async () => {
  const actual = await vi.importActual<
    typeof import("../../../api/integrations")
  >("../../../api/integrations");
  return {
    ...actual,
    startComposioSignin: () => startComposioSignin(),
    getComposioSigninStatus: () => getComposioSigninStatus(),
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
