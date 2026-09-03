/**
 * CeoExecutionLineup — Phase 4 execution roster suggestion card.
 *
 * Rendered inside the CEO DM when the broker proposes a bot roster
 * for executing an approved issue. The user can accept or decline each
 * bot individually before submitting.
 *
 * Universal three-stage card matrix (spec design review decisions - State coverage):
 *   pending    — list of bots with role + reason + Accept/Decline chips
 *   submitting — button disabled, inline spinner
 *   committed  — collapses to a one-line confirmation in --text-secondary
 *
 * Sanitization: all bot strings (slug, role, reason) are rendered as
 * React text children, never via innerHTML. Backend sanitization via
 * sanitizeContextValue (PR 684) is inherited through the existing
 * suggestion payload path.
 *
 * Keyboard a11y: Accept/Decline chips are Tab-navigable; Enter and Space
 * activate them.
 *
 * Wire: submit POSTs to /onboarding/suggestion/ack with
 * { suggestion_id, selected_agent_slugs }.
 */

import { useState } from "react";

import { post } from "../../../api/client";
import type {
  CardStage,
  CeoExecutionLineupPayload,
  ExecutionLineupBot,
} from "../../onboarding/types";
import { showNotice } from "../../ui/Toast";

interface CeoExecutionLineupProps {
  payload: CeoExecutionLineupPayload;
  stage: CardStage;
  onStageChange: (next: CardStage) => void;
}

/**
 * One bot row with Accept / Decline toggle chips.
 * Renders slug/role/reason as plain text nodes.
 */
function BotRow({
  agent,
  accepted,
  disabled,
  onToggle,
}: {
  agent: ExecutionLineupBot;
  accepted: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="ceo-lineup-bot-row"
      data-testid={`lineup-bot-row-${agent.slug}`}
    >
      <div className="ceo-lineup-bot-info">
        <span className="ceo-lineup-bot-role">{agent.role}</span>
        <span className="ceo-lineup-bot-reason">{agent.reason}</span>
      </div>
      <button
        type="button"
        className={`ceo-lineup-chip ${accepted ? "ceo-lineup-chip--accept" : "ceo-lineup-chip--decline"}`}
        disabled={disabled}
        onClick={onToggle}
        aria-pressed={accepted}
        aria-label={`${accepted ? "Decline" : "Accept"} ${agent.role}`}
        data-testid={`lineup-chip-${agent.slug}`}
      >
        {accepted ? "Accept" : "Decline"}
      </button>
    </div>
  );
}

export function CeoExecutionLineup({
  payload,
  stage,
  onStageChange,
}: CeoExecutionLineupProps) {
  // All bots accepted by default per spec.
  const [accepted, setAccepted] = useState<Set<string>>(
    () => new Set(payload.agents.map((a) => a.slug)),
  );

  if (stage === "committed") {
    const count = accepted.size;
    return (
      <div
        className="ceo-card ceo-card--committed"
        role="status"
        data-testid="lineup-committed"
      >
        <span className="ceo-card-committed-text">
          &#10003; {count} {count === 1 ? "bot" : "bots"} added to roster
        </span>
      </div>
    );
  }

  const isSubmitting = stage === "submitting";
  const selectedCount = accepted.size;

  const toggleBot = (slug: string) => {
    if (isSubmitting) return;
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (isSubmitting || selectedCount === 0) return;
    onStageChange("submitting");
    try {
      await post("/onboarding/suggestion/ack", {
        suggestion_id: payload.suggestion_id,
        selected_agent_slugs: [...accepted],
      });
      onStageChange("committed");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to confirm lineup";
      showNotice(message, "error");
      onStageChange("pending");
    }
  };

  return (
    <div
      className="ceo-card ceo-card--execution-lineup"
      data-testid="ceo-execution-lineup"
    >
      <div className="ceo-card-label">Proposed execution lineup</div>
      <ul className="ceo-lineup-agents" aria-label="Proposed bots">
        {payload.agents.map((agent) => (
          <li key={agent.slug}>
            <BotRow
              agent={agent}
              accepted={accepted.has(agent.slug)}
              disabled={isSubmitting}
              onToggle={() => toggleBot(agent.slug)}
            />
          </li>
        ))}
      </ul>
      <div className="ceo-card-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm ceo-card-submit"
          disabled={isSubmitting || selectedCount === 0}
          onClick={() => void handleSubmit()}
          data-testid="lineup-submit"
          aria-label={`Spin up ${selectedCount} ${selectedCount === 1 ? "bot" : "bots"}`}
        >
          {isSubmitting ? (
            <span className="ceo-card-spinner" aria-hidden="true" />
          ) : null}
          {isSubmitting
            ? "Spinning up…"
            : `Spin up ${selectedCount} ${selectedCount === 1 ? "bot" : "bots"}`}
        </button>
      </div>
    </div>
  );
}
