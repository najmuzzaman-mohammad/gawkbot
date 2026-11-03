import type { Meta, StoryObj } from "@storybook/react-vite";

import { ComposioSigninPanel } from "./ComposioSigninPanel";

// Every phase of the Composio sign-in, including the ones a connect attempt
// now starts on its own. The states that matter here are the honest ones: a
// sign-in the user did not click for (and can stop), the one-time setup that
// asks before installing anything, and the two ways it can fail.
//
// Copy rule to check by eye: no sentence in any of these carries a status code,
// a slug, an identifier, an environment variable, or a shell command. The
// install command lives behind the disclosure, addressed to whoever can run it.

const INSTALL_COMMAND = "curl -fsSL https://example.test/install.sh | bash";
const AUTH_URL = "https://platform.composio.dev/login?cliKey=example";

function Wrapped(props: React.ComponentProps<typeof ComposioSigninPanel>) {
  return (
    <div className="composio-expired" style={{ maxWidth: 560 }}>
      <p className="composio-expired-message">
        Your Composio sign-in has expired. Signing you back in now.
      </p>
      <ComposioSigninPanel {...props} />
    </div>
  );
}

const meta: Meta<typeof Wrapped> = {
  title: "Features/Integrations/ComposioSigninPanel",
  component: Wrapped,
  parameters: { layout: "centered" },
  args: {
    phase: "idle",
    authUrl: "",
    installCommand: "",
    starting: false,
    ctaLabel: "Sign in again",
    onStart: () => {},
    onCancel: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof Wrapped>;

/** Nothing running: the explicit button, which is also the fallback after a cancel. */
export const Idle: Story = {};

/** Started by a connect attempt, waiting on the browser. Link, copy, cancel. */
export const AwaitingLogin: Story = {
  args: { phase: "awaiting_login", authUrl: AUTH_URL },
};

/** The degraded case: no link to open, so the copy does not pretend there is one. */
export const AwaitingLoginWithoutLink: Story = {
  args: { phase: "awaiting_login", authUrl: "" },
};

/** The destructive-action carve-out: installing software asks first. */
export const InstallRequired: Story = {
  args: { phase: "install_required", installCommand: INSTALL_COMMAND },
};

export const Installing: Story = {
  args: { phase: "installing", installCommand: INSTALL_COMMAND },
};

/** The install was agreed to and still did not finish. */
export const SetupDidNotFinish: Story = {
  args: { phase: "cli_missing", installCommand: INSTALL_COMMAND },
};

export const Provisioning: Story = {
  args: { phase: "provisioning" },
};
