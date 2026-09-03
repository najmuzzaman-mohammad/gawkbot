import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeMember } from "../../../api/client";
import type { ComputerRuntime, ComputerStatus } from "../../../api/computer";
import { useAppStore } from "../../../stores/app";

const computerApi = vi.hoisted(() => ({
  getComputer: vi.fn(),
  getComputerRuntime: vi.fn(),
  prepareComputerRuntime: vi.fn(),
  computerAction: vi.fn(),
  computerExec: vi.fn(),
  computerJoin: vi.fn(),
  computerControl: vi.fn(),
  updateMemberComputer: vi.fn(),
  getBoxAccount: vi.fn(),
  startBoxSignin: vi.fn(),
  getBoxSigninStatus: vi.fn(),
  signOutBox: vi.fn(),
}));
const clientApi = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
const showNoticeMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("../../../api/computer", async () => {
  const actual = await vi.importActual<typeof import("../../../api/computer")>(
    "../../../api/computer",
  );
  return { ...actual, ...computerApi };
});

vi.mock("../../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../../api/client")>(
    "../../../api/client",
  );
  return { ...actual, ...clientApi };
});

vi.mock("../../ui/Toast", () => ({ showNotice: showNoticeMock }));
vi.mock("../../ui/ConfirmDialog", () => ({
  confirm: confirmMock,
  ConfirmHost: () => null,
}));

import { ComputerTab } from "./ComputerTab";

const SLUG = "growth";
const agent: OfficeMember = {
  slug: SLUG,
  name: "Growth",
  role: "Demand generation",
  status: "active",
};

function status(over: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    slug: SLUG,
    destination: "sandbox",
    cloudBackend: "box",
    state: "ready",
    problem: null,
    busy: false,
    viewerUrl: null,
    control: { held: false, helpReason: null },
    lastFrame: null,
    containerName: null,
    workspaceDir: null,
    box: null,
    ...over,
  };
}

function runtime(over: Partial<ComputerRuntime> = {}): ComputerRuntime {
  return {
    available: false,
    runtime: "",
    daemonUp: false,
    image: false,
    imageRef: "",
    driverVersion: "",
    building: false,
    installHint: "",
    runtimeStartHint: "",
    problem: "",
    ...over,
  };
}

function renderTab(member: OfficeMember = agent) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ComputerTab agent={member} />
      </QueryClientProvider>,
    ),
  };
}

function resetStore() {
  useAppStore.setState({
    computerStates: {},
    computerRuntimeBuild: { building: false, problem: null, lines: [] },
  });
}

beforeEach(() => {
  computerApi.getBoxAccount.mockResolvedValue({
    keySet: false,
    signedIn: false,
    identifier: "",
    cliInstalled: true,
    canStart: null,
    blockedReason: "",
    plan: "",
    trialLine: "",
    billingUrl: "https://box.ascii.dev/box/dashboard?tab=billing",
  });
  resetStore();
  computerApi.getComputerRuntime.mockResolvedValue(runtime());
  clientApi.getConfig.mockResolvedValue({ box_key_set: false });
  clientApi.updateConfig.mockResolvedValue({});
  computerApi.computerAction.mockImplementation(async (_s: string, a: string) =>
    status({ state: a === "sleep" ? "asleep" : "starting" }),
  );
  computerApi.computerControl.mockResolvedValue({
    held: false,
    helpReason: null,
  });
  computerApi.computerJoin.mockResolvedValue({
    viewerUrl: "/computer-view/growth/control/9/sig/vnc.html",
  });
  computerApi.updateMemberComputer.mockResolvedValue(undefined);
  computerApi.prepareComputerRuntime.mockResolvedValue({ building: true });
  computerApi.computerExec.mockResolvedValue({
    exitCode: 0,
    stdout: "invoices.csv",
    stderr: "",
  });
  confirmMock.mockImplementation((opts: { onConfirm: () => void }) =>
    opts.onConfirm(),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetStore();
});

describe("<ComputerTab> phases", () => {
  it("off: says the computer is off and offers the Runs on picker", async () => {
    computerApi.getComputer.mockResolvedValue(
      status({ state: "off", destination: "off" }),
    );
    renderTab();

    expect(
      await screen.findByText("This bot's computer is off"),
    ).toBeInTheDocument();
    expect(screen.getByText("Growth's screen")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Local VM" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("computer-viewer")).not.toBeInTheDocument();
    expect(screen.queryByText("Take control")).not.toBeInTheDocument();
  });

  it("runtime_missing: shows install + cloud paths side by side and saves the Box key", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(
      status({ state: "runtime_missing" }),
    );
    computerApi.getComputerRuntime.mockResolvedValue(
      runtime({ installHint: "Install OrbStack, then open it once." }),
    );
    renderTab();

    expect(
      await screen.findByTestId("computer-runtime-paths"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Install OrbStack, then open it once/),
    ).toBeInTheDocument();
    const install = screen.getByRole("link", { name: /Install OrbStack/ });
    expect(install).toHaveAttribute("href", "https://orbstack.dev");
    expect(screen.getByText("Use a cloud computer")).toBeInTheDocument();
    expect(await screen.findByTestId("box-signin")).toBeInTheDocument();

    await user.click(screen.getByTestId("box-paste"));
    await user.type(screen.getByLabelText("ascii.dev Box API key"), "box_abc");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(clientApi.updateConfig).toHaveBeenCalledWith({
        box_api_key: "box_abc",
      }),
    );
  });

  it("runtime_missing: reflects an already-set Box key", async () => {
    computerApi.getComputer.mockResolvedValue(
      status({ state: "runtime_missing" }),
    );
    computerApi.getBoxAccount.mockResolvedValue({
      keySet: true,
      signedIn: true,
      identifier: "sam@example.com",
      cliInstalled: true,
      canStart: false,
      blockedReason: "subscription_required",
      plan: "trial",
      trialLine: "",
      billingUrl: "https://box.ascii.dev/box/dashboard?tab=billing",
    });
    renderTab();

    await waitFor(() =>
      expect(screen.getByTestId("box-account-line")).toHaveTextContent(
        "sam@example.com",
      ),
    );
    // A saved key is not the whole story: the plan gate is named with a link.
    expect(screen.getByTestId("box-plan-notice-link")).toHaveAttribute(
      "href",
      "https://box.ascii.dev/box/dashboard?tab=billing",
    );
    expect(screen.getByTestId("box-signout")).toBeInTheDocument();
  });

  it("image_missing: prepares the shared image and streams build lines", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(
      status({ state: "image_missing" }),
    );
    renderTab();

    await user.click(
      await screen.findByRole("button", { name: "Prepare the desktop image" }),
    );

    await waitFor(() =>
      expect(computerApi.prepareComputerRuntime).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByText("Building the desktop image"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("First time only, about two minutes."),
    ).toBeInTheDocument();

    useAppStore.getState().recordComputerEvent({
      slug: "",
      state: "building",
      message: "Step 3/9: install cua-driver",
    });
    expect(
      await screen.findByText("Step 3/9: install cua-driver"),
    ).toBeInTheDocument();
  });

  it("missing: creates the bot's computer on click", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(status({ state: "missing" }));
    renderTab();

    await user.click(
      await screen.findByRole("button", { name: "Create Growth's computer" }),
    );

    await waitFor(() =>
      expect(computerApi.computerAction).toHaveBeenCalledWith(
        SLUG,
        "provision",
      ),
    );
  });

  it("asleep: offers Start", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(status({ state: "asleep" }));
    renderTab();

    expect(
      await screen.findByText("Growth's computer is asleep"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(computerApi.computerAction).toHaveBeenCalledWith(SLUG, "start"),
    );
  });

  it("error: shows the problem and retries", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(
      status({ state: "error", problem: "container refused: missing label" }),
    );
    renderTab();

    expect(
      await screen.findByText("container refused: missing label"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(computerApi.computerAction).toHaveBeenCalledWith(
        SLUG,
        "provision",
      ),
    );
  });

  it("provisioning: spinner copy, no actions", async () => {
    computerApi.getComputer.mockResolvedValue(
      status({ state: "provisioning" }),
    );
    renderTab();
    expect(
      await screen.findByText("Creating Growth's computer…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sleep" }),
    ).not.toBeInTheDocument();
  });
});

describe("<ComputerTab> ready", () => {
  it("embeds the live viewer with the view policy and a locked sandbox", async () => {
    computerApi.getComputer.mockResolvedValue(
      status({ viewerUrl: "/computer-view/growth/view/1/sig/vnc.html" }),
    );
    renderTab();

    const frame = await screen.findByTitle("Growth's screen");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute(
      "src",
      "/computer-view/growth/view/1/sig/vnc.html",
    );
    expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms",
    );
    expect(screen.getByTestId("computer-destination")).toHaveTextContent(
      "Local VM",
    );
    expect(
      screen.getByRole("button", { name: "Take control" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sleep" })).toBeInTheDocument();
    expect(screen.getByTestId("computer-console")).toBeInTheDocument();
  });

  it("falls back to the settled frame, then to a live SSE frame between polls", async () => {
    computerApi.getComputer.mockResolvedValue(
      status({ lastFrame: { dataUrl: "data:image/jpeg;base64,OLD", at: 10 } }),
    );
    renderTab();

    const img = await screen.findByAltText("Growth's screen");
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,OLD");

    useAppStore.getState().recordComputerEvent({
      slug: SLUG,
      state: "ready",
      frame: "data:image/jpeg;base64,LIVE",
      at: 20,
    });
    await waitFor(() =>
      expect(screen.getByAltText("Growth's screen")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,LIVE",
      ),
    );
  });

  it("labels a cloud destination", async () => {
    computerApi.getComputer.mockResolvedValue(
      status({ destination: "cloud", box: { boxId: "b1", state: "running" } }),
    );
    renderTab();
    expect(await screen.findByTestId("computer-destination")).toHaveTextContent(
      "cloud",
    );
    // Box has no remove: no delete button for cloud computers.
    expect(
      screen.queryByRole("button", { name: "Delete this bot's computer" }),
    ).not.toBeInTheDocument();
  });

  it("shows the help request and takes control: control(take), join, then the control viewer", async () => {
    const user = userEvent.setup();
    const viewerUrl = "/computer-view/growth/view/1/sig/vnc.html";
    computerApi.getComputer.mockResolvedValue(
      status({
        viewerUrl,
        control: { held: false, helpReason: "Xero wants a login" },
      }),
    );
    computerApi.computerControl.mockImplementation(async () => {
      computerApi.getComputer.mockResolvedValue(
        status({ viewerUrl, control: { held: true, helpReason: null } }),
      );
      return { held: true, helpReason: null };
    });
    renderTab();

    const card = await screen.findByTestId("computer-help-card");
    expect(card).toHaveTextContent("asked for your hands: Xero wants a login");

    await user.click(screen.getByRole("button", { name: "Take control" }));

    await waitFor(() =>
      expect(computerApi.computerControl).toHaveBeenCalledWith(SLUG, "take"),
    );
    await waitFor(() =>
      expect(computerApi.computerJoin).toHaveBeenCalledWith(SLUG),
    );
    const order = [
      computerApi.computerControl.mock.invocationCallOrder[0],
      computerApi.computerJoin.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);

    await waitFor(() =>
      expect(screen.getByTitle("Growth's screen")).toHaveAttribute(
        "src",
        "/computer-view/growth/control/9/sig/vnc.html",
      ),
    );
    expect(await screen.findByTestId("computer-held-card")).toHaveTextContent(
      "You have the wheel",
    );
    expect(screen.queryByTestId("computer-help-card")).not.toBeInTheDocument();
  });

  it("dismisses a help request without taking the wheel", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(
      status({ control: { held: false, helpReason: "needs a captcha" } }),
    );
    // The broker clears the request; the next poll must agree with the
    // local store write or the card would flicker back.
    computerApi.computerControl.mockImplementation(async () => {
      computerApi.getComputer.mockResolvedValue(status());
      return { held: false, helpReason: null };
    });
    renderTab();

    await screen.findByTestId("computer-help-card");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(computerApi.computerControl).toHaveBeenCalledWith(
        SLUG,
        "dismiss-help",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("computer-help-card"),
      ).not.toBeInTheDocument(),
    );
    expect(computerApi.computerJoin).not.toHaveBeenCalled();
  });

  it("held: hands control back", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(
      status({ control: { held: true, helpReason: null } }),
    );
    computerApi.computerControl.mockImplementation(async () => {
      computerApi.getComputer.mockResolvedValue(status());
      return { held: false, helpReason: null };
    });
    renderTab();

    const held = await screen.findByTestId("computer-held-card");
    expect(held).toHaveTextContent(
      "the bot's clicks and keystrokes are refused until you hand it back",
    );
    expect(
      screen.queryByRole("button", { name: "Take control" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hand control back" }));

    await waitFor(() =>
      expect(computerApi.computerControl).toHaveBeenCalledWith(SLUG, "release"),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("computer-held-card"),
      ).not.toBeInTheDocument(),
    );
  });

  it("sleeps the computer", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(status());
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Sleep" }));
    await waitFor(() =>
      expect(computerApi.computerAction).toHaveBeenCalledWith(SLUG, "sleep"),
    );
  });

  it("deletes a sandbox computer only after the confirm dialog", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(status());
    renderTab();

    await user.click(
      await screen.findByRole("button", { name: "Delete this bot's computer" }),
    );

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true, confirmLabel: "Delete" }),
    );
    await waitFor(() =>
      expect(computerApi.computerAction).toHaveBeenCalledWith(SLUG, "remove"),
    );
  });

  it("refuses to delete while the bot is mid-turn", async () => {
    computerApi.getComputer.mockResolvedValue(status({ busy: true }));
    renderTab();
    expect(
      await screen.findByRole("button", { name: "Delete this bot's computer" }),
    ).toBeDisabled();
  });

  it("runs a console command and shows the output", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(status());
    renderTab();

    await screen.findByTestId("computer-console");
    await user.click(screen.getByText("Console"));
    await user.type(screen.getByLabelText("Command"), "ls ~/workspace");
    await user.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(computerApi.computerExec).toHaveBeenCalledWith(
        SLUG,
        "ls ~/workspace",
      ),
    );
    expect(
      await screen.findByTestId("computer-console-output"),
    ).toHaveTextContent("invoices.csv");
  });
});

describe("<ComputerTab> runs on", () => {
  it("updates the member's computer setting through office-members", async () => {
    const user = userEvent.setup();
    computerApi.getComputer.mockResolvedValue(
      status({ state: "off", destination: "off" }),
    );
    const { client } = renderTab({ ...agent, computer: "off" });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    expect(await screen.findByRole("button", { name: "Off" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Cloud" }));

    await waitFor(() =>
      expect(computerApi.updateMemberComputer).toHaveBeenCalledWith(
        SLUG,
        "cloud",
      ),
    );
    await waitFor(() => {
      const keys = invalidateSpy.mock.calls.map(
        (c) => (c[0] as { queryKey?: unknown[] }).queryKey,
      );
      expect(keys).toContainEqual(["office-members"]);
    });
  });

  it("highlights what auto resolved to when no setting is saved", async () => {
    computerApi.getComputer.mockResolvedValue(
      status({ destination: "sandbox" }),
    );
    renderTab({ ...agent, computer: "" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Local VM" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(screen.getByText(/Auto picks a Local VM/)).toBeInTheDocument();
  });
});
