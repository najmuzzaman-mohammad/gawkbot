import type { ReactNode } from "react";

interface DataEmptyStateProps {
  title: string;
  body: string;
  /** At most one primary action. */
  action?: ReactNode;
}

/** Short headline, one line of body copy, one action. Never a bare "No data". */
export function DataEmptyState({ title, body, action }: DataEmptyStateProps) {
  return (
    <div className="data-empty" role="status">
      <h2 className="data-empty-title">{title}</h2>
      <p className="data-empty-body">{body}</p>
      {action ? <div className="data-empty-action">{action}</div> : null}
    </div>
  );
}
