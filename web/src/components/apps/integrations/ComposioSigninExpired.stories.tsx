import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposioSigninExpired } from "./ComposioSigninExpired";

// The panel that replaced a raw 401 in front of a user trying to connect Gmail.
// Two states matter: with a request id (a support handle, collapsed behind
// details) and without one.

function Wrapped({
  requestId,
  neverSignedIn,
}: {
  requestId?: string;
  neverSignedIn?: boolean;
}) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <div className="op-page" style={{ maxWidth: 720 }}>
        <header className="op-page-header">
          <h2>Integrations</h2>
          <p>External accounts, gateways, channels, and action audit.</p>
        </header>
        <ComposioSigninExpired
          requestId={requestId}
          neverSignedIn={neverSignedIn}
        />
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

/**
 * First run: nothing expired, there has simply never been a sign-in. Same
 * recovery, different sentence — "expired" would be a lie here.
 *
 * These stories deliberately do NOT auto-start: a story that fired a real
 * sign-in request on render would be a playground that changes the machine it
 * runs on. The automatic start is covered by the panel's tests.
 */
export const NeverSignedIn: Story = {
  args: { neverSignedIn: true },
};
