import { Button } from "../DataButton";

import "../../../styles/data-records.css";

export interface SelectionToolbarProps {
  count: number;
  onDelete: () => void;
  onClear: () => void;
}

/** Shown in place of nothing: it only exists while rows are selected. */
export function SelectionToolbar({
  count,
  onDelete,
  onClear,
}: SelectionToolbarProps) {
  if (count === 0) return null;
  return (
    <div
      className="dr-selection-bar"
      role="toolbar"
      aria-label="Selected records"
    >
      <span className="dr-selection-count" role="status">
        {count.toLocaleString()} selected
      </span>
      <Button variant="destructive" size="sm" onClick={onDelete}>
        Delete
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
