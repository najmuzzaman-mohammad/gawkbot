import "../../../styles/data-records.css";

const SKELETON_ROWS = 8;
const SKELETON_COLUMNS = 5;
const ROWS = Array.from({ length: SKELETON_ROWS }, (_, index) => index);
const COLUMNS = Array.from({ length: SKELETON_COLUMNS }, (_, index) => index);

export interface RecordsSkeletonProps {
  label: string;
}

/** Rows of muted bars in the table's own layout. Never a full-page spinner. */
export function RecordsSkeleton({ label }: RecordsSkeletonProps) {
  return (
    <div
      className="dr-table-scroll dr-skeleton"
      role="status"
      aria-label={label}
      data-testid="data-records-skeleton"
    >
      <div className="dr-skeleton-row dr-skeleton-row--head" aria-hidden="true">
        {COLUMNS.map((column) => (
          <span key={column} className="dr-skeleton-bar" data-short="true" />
        ))}
      </div>
      {ROWS.map((row) => (
        <div key={row} className="dr-skeleton-row" aria-hidden="true">
          {COLUMNS.map((column) => (
            <span
              key={column}
              className="dr-skeleton-bar"
              data-short={(row + column) % 3 === 0 ? "true" : "false"}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
