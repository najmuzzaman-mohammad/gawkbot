import { Link } from "@tanstack/react-router";
import { Xmark } from "iconoir-react";

import type { RecordRef } from "../../../api/dataspaces";

import "../../../styles/data-records.css";

export interface RelationshipChipProps {
  spaceId: string;
  target: RecordRef;
  /** Withhold to render a read-only chip with no unlink button. */
  onUnlink?: () => void;
  /** Completes the unlink button's name: "Unlink Tidewrack Capital from {this}". */
  ownerName?: string;
  disabled?: boolean;
}

/** One linked record: a real link to its page, plus an optional unlink. */
export function RelationshipChip({
  spaceId,
  target,
  onUnlink,
  ownerName,
  disabled = false,
}: RelationshipChipProps) {
  return (
    <span className="dr-chip">
      <Link
        className="dr-chip-link"
        to="/data/$spaceId/r/$recordId"
        params={{ spaceId, recordId: target.id }}
        title={target.name}
      >
        {target.name}
      </Link>
      {onUnlink ? (
        <button
          type="button"
          className="dr-chip-remove"
          aria-label={
            ownerName
              ? `Unlink ${target.name} from ${ownerName}`
              : `Unlink ${target.name}`
          }
          disabled={disabled}
          onClick={onUnlink}
        >
          <Xmark aria-hidden="true" focusable="false" />
        </button>
      ) : null}
    </span>
  );
}
