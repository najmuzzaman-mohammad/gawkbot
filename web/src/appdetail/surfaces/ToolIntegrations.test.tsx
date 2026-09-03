import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolIntegrations } from "./ToolIntegrations";

// The catalog cannot exist without a Composio key, so the tab must fall back
// to the shipped ComposioOnboarding (sign-in / key paste) on first run.

const getConfigMock = vi.fn();
vi.mock("../../api/client", () => ({
  getConfig: () => getConfigMock(),
}));

// ConnectIntegrationCard (reused unmocked) pulls the connect/signin helpers
// from the same module; they only fire on interaction, so inert stubs suffice.
const listIntegrationsMock = vi.fn();
vi.mock("../../api/integrations", () => ({
  listIntegrations: (opts: unknown) => listIntegrationsMock(opts),
  getComposioSigninStatus: vi.fn(),
  getIntegrationConnectStatus: vi.fn(),
  startComposioSignin: vi.fn(),
  startIntegrationConnection: vi.fn(),
}));

// Unit scope: the onboarding flow itself is covered by its own tests.
vi.mock("../../components/apps/integrations/ComposioOnboarding", () => ({
  ComposioOnboarding: () => <div data-testid="composio-onboarding" />,
}));

function renderTab(
  props: Partial<{ usedNames: string[]; usedHeading: string }> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToolIntegrations
        usedNames={props.usedNames ?? []}
        usedHeading={props.usedHeading}
      />
    </QueryClientProvider>,
  );
}

describe("ToolIntegrations", () => {
  beforeEach(() => {
    getConfigMock.mockReset();
    listIntegrationsMock.mockReset();
  });

  it("shows Composio onboarding when no key is connected yet", async () => {
    getConfigMock.mockResolvedValue({ composio_key_set: false });
    const { findByTestId } = renderTab();
    expect(await findByTestId("composio-onboarding")).toBeTruthy();
    // Without a key there is no catalog to fetch.
    expect(listIntegrationsMock).not.toHaveBeenCalled();
  });

  it("shows the catalog once a Composio key is connected", async () => {
    getConfigMock.mockResolvedValue({ composio_key_set: true });
    listIntegrationsMock.mockResolvedValue({
      items: [
        {
          platform: "slack",
          name: "Slack",
          state: "connected",
          can_connect: true,
        },
        {
          platform: "github",
          name: "GitHub",
          state: "available",
          can_connect: true,
        },
      ],
    });
    const { findByText, getByText, queryByTestId } = renderTab();
    expect(await findByText("Slack")).toBeTruthy();
    expect(getByText("GitHub")).toBeTruthy();
    expect(getByText("Connect")).toBeTruthy();
    expect(queryByTestId("composio-onboarding")).toBeNull();
  });

  it("frames the scoped chips under the caller's heading (not always 'Used by this tool')", async () => {
    getConfigMock.mockResolvedValue({ composio_key_set: true });
    listIntegrationsMock.mockResolvedValue({ items: [] });
    const { findByText, queryByText } = renderTab({
      usedNames: ["GitHub"],
      usedHeading: "Connected for your workspace",
    });
    // The bot-app path relabels the chips honestly.
    expect(await findByText("Connected for your workspace")).toBeTruthy();
    expect(await findByText("GitHub")).toBeTruthy();
    // …and drops the misleading "Used by this tool" framing.
    expect(queryByText("Used by this tool")).toBeNull();
  });
});
