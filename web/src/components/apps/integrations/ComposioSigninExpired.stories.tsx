import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposioSigninExpired } from "./ComposioSigninExpired";

// The panel that replaced a raw 401 in front of a user trying to connect Gmail.
// Two states matter: with a request id (a support handle, collapsed behind
// details) and without one.

function Wrapped({ requestId }: { requestId?: string }) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <div className="op-page" style={{ maxWidth: 720 }}>
        <header className="op-page-header">
          <h2>Integrations</h2>
          <p>External accounts, gateways, channels, and action audit.</p>
        </header>
        <ComposioSigninExpired requestId={requestId} />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof Wrapped> = {
  title: "Features/Integrations/ComposioSigninExpired",
  component: Wrapped,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof Wrapped>;

export const Expired: Story = {};

export const WithSupportDetails: Story = {
  args: { requestId: "9466302c-0000-0000-0000-000000000000" },
};
