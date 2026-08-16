// ApprovalPrompt — the operator's auto-surfaced approval. Whenever an action
// needs the human's sign-off (e.g. an app's mutating Slack send), this pops as a
// modal asking the operator to Approve or Reject. The human approves; the agent
// never self-approves. Mounted globally in the operator shell.

import { useEffect, useState } from "react";
import { ShieldCheck, X } from "lucide-react";

import { useOperatorApprovals } from "../approvals/useOperatorApprovals";
import { Eyebrow } from "./primitives";

export function ApprovalPrompt() {
  const { pending, approve, reject, answering } = useOperatorApprovals();
  const req = pending[0];
  // The trust beat: after the LAST pending approval clears via Approve, hold
  // a 2.4s confirmation in the card's place — the modal used to just vanish
  // (2026-08-16 delight audit). Straight copy; this is a safety surface.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!(confirming && !req)) return;
    const t = window.setTimeout(() => setConfirming(false), 2400);
    return () => window.clearTimeout(t);
  }, [confirming, req]);
  if (!req) {
    if (!confirming) return null;
    return (
      <div className="opr-approval-prompt opr-approval-sent" role="status">
        <span className="opr-approval-prompt-glyph" aria-hidden={true}>
          <ShieldCheck size={16} strokeWidth={1.8} />
        </span>
        <span>Sent. Nothing leaves the office without you.</span>
      </div>
    );
  }

  const more = pending.length - 1;

  return (
    <div
      className="opr-approval-prompt"
      role="dialog"
      aria-label="Approval needed"
    >
      <div className="opr-approval-prompt-head">
        <span className="opr-approval-prompt-glyph" aria-hidden={true}>
          <ShieldCheck size={16} strokeWidth={1.8} />
        </span>
        <Eyebrow>Approval needed</Eyebrow>
        <button
          type="button"
          className="opr-icon-btn"
          aria-label="Dismiss"
          onClick={() => reject(req.id)}
          disabled={answering}
        >
          <X size={14} strokeWidth={1.9} />
        </button>
      </div>

      <div className="opr-approval-prompt-title">
        {req.title?.trim() || req.question}
      </div>
      {req.title?.trim() && req.question ? (
        <p className="opr-scoped-note">{req.question}</p>
      ) : null}
      {req.context?.trim() ? (
        <pre className="opr-approval-prompt-ctx">{req.context}</pre>
      ) : null}

      <div className="opr-approval-prompt-actions">
        <button
          type="button"
          className="opr-btn opr-btn-primary opr-btn-sm"
          onClick={() => {
            approve(req.id);
            setConfirming(true);
          }}
          disabled={answering}
        >
          {answering ? "Approving…" : "Approve & send"}
        </button>
        <button
          type="button"
          className="opr-btn opr-btn-sm"
          onClick={() => reject(req.id)}
          disabled={answering}
        >
          Reject
        </button>
        {more > 0 ? (
          <span className="opr-scoped-note" style={{ marginLeft: "auto" }}>
            +{more} more waiting
          </span>
        ) : null}
      </div>
    </div>
  );
}
