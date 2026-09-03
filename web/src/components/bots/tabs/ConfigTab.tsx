/**
 * Config tab — wraps BotProfilePanel in headless mode (no header/close).
 * The shell header already shows the name, avatar, status; this tab shows
 * only the scrollable body with all config sections intact.
 */

import type { OfficeMember } from "../../../api/client";
import { BotProfilePanel } from "../BotProfilePanel";

interface ConfigTabProps {
  agent: OfficeMember;
}

// Noop onClose because the shell header owns navigation, not this tab.
function noop() {}

export function ConfigTab({ agent }: ConfigTabProps) {
  return (
    <div className="bot-config-tab" data-testid="config-tab">
      <BotProfilePanel agent={agent} onClose={noop} headless={true} />
    </div>
  );
}
