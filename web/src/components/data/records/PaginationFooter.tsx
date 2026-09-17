import { NavArrowLeft, NavArrowRight } from "iconoir-react";

import { PAGE_SIZE_OPTIONS } from "../../../api/dataspaces";

import "../../../styles/data-records.css";

export interface PaginationFooterProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function lastPageFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function rangeLabel(
  page: number,
  pageSize: number,
  total: number,
): string {
  if (total === 0) return "0 records";
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return `${first.toLocaleString()} to ${last.toLocaleString()} of ${total.toLocaleString()}`;
}

/** "1 to 30 of 212", previous and next, and the page size. All URL state. */
export function PaginationFooter({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: PaginationFooterProps) {
  const lastPage = lastPageFor(total, pageSize);
  return (
    <nav className="dr-pagination" aria-label="Pagination">
      <span className="dr-pagination-range" role="status">
        {rangeLabel(page, pageSize, total)}
      </span>
      <label className="dr-pagination-size">
        <span>Rows per page</span>
        <select
          className="dr-filter-control"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {PAGE_SIZE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <div className="dr-pagination-steps">
        <button
          type="button"
          className="dr-icon-button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <NavArrowLeft aria-hidden="true" focusable="false" />
        </button>
        <span className="dr-pagination-page">
          Page {page.toLocaleString()} of {lastPage.toLocaleString()}
        </span>
        <button
          type="button"
          className="dr-icon-button"
          aria-label="Next page"
          disabled={page >= lastPage}
          onClick={() => onPageChange(page + 1)}
        >
          <NavArrowRight aria-hidden="true" focusable="false" />
        </button>
      </div>
    </nav>
  );
}
