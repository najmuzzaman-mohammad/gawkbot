import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Filter, Search, Xmark } from "iconoir-react";

import type { FilterClause, ObjectType } from "../../../api/dataspaces";
import { FilterPanel } from "./FilterPanel";
import type { TableSort } from "./RecordsTable";
import { useDebouncedValue } from "./useDebouncedValue";

import "../../../styles/data-records.css";

const SEARCH_DEBOUNCE_MS = 250;

const SYSTEM_SORT_LABELS: Readonly<Record<string, string>> = {
  _updated_at: "Updated",
  _created_at: "Created",
  _created_by: "Created by",
};

export function sortLabel(type: ObjectType, sort: TableSort): string {
  const attribute = type.attributes.find(
    (item) => item.slug === sort.attribute,
  );
  const name =
    attribute?.name ?? SYSTEM_SORT_LABELS[sort.attribute] ?? sort.attribute;
  return `Sorted by ${name}, ${sort.direction === "asc" ? "ascending" : "descending"}`;
}

export interface RecordsToolbarProps {
  type: ObjectType;
  filters: readonly FilterClause[];
  onFiltersChange: (filters: readonly FilterClause[]) => void;
  sort: TableSort | null;
  onClearSort: () => void;
  /** The `q` search param. */
  query: string;
  onQueryChange: (query: string) => void;
}

interface SearchBoxProps {
  label: string;
  query: string;
  onQueryChange: (query: string) => void;
}

/**
 * The text is local so typing stays instant; the URL trails it by a beat.
 * When the URL changes from elsewhere (a cleared filter state, the back
 * button) the box follows, unless that change is just our own echo.
 */
function SearchBox({ label, query, onQueryChange }: SearchBoxProps) {
  const [text, setText] = useState(query);
  const settled = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);
  const lastSentRef = useRef(query);
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;

  useEffect(() => {
    const next = settled.trim();
    if (next === lastSentRef.current) return;
    lastSentRef.current = next;
    onQueryChangeRef.current(next);
  }, [settled]);

  useEffect(() => {
    if (query === lastSentRef.current) return;
    lastSentRef.current = query;
    setText(query);
  }, [query]);

  const clear = () => {
    setText("");
    lastSentRef.current = "";
    onQueryChange("");
  };

  return (
    <div className="dr-search">
      <Search className="dr-search-icon" aria-hidden="true" focusable="false" />
      <input
        className="dr-search-input"
        type="text"
        aria-label={label}
        placeholder={label}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {text === "" ? null : (
        <button
          type="button"
          className="dr-icon-button"
          aria-label="Clear search"
          onClick={clear}
        >
          <Xmark aria-hidden="true" focusable="false" />
        </button>
      )}
    </div>
  );
}

/** Filter button with its count, the sort readout, and the search box. */
export function RecordsToolbar({
  type,
  filters,
  onFiltersChange,
  sort,
  onClearSort,
  query,
  onQueryChange,
}: RecordsToolbarProps) {
  const filterCount = filters.length;
  return (
    <div className="dr-toolbar">
      <Popover.Root>
        <Popover.Trigger
          className="dr-toolbar-button"
          data-active={filterCount > 0 ? "true" : "false"}
        >
          <Filter aria-hidden="true" focusable="false" />
          Filter
          {filterCount > 0 ? (
            <span className="dr-count-badge">
              {filterCount}
              <span className="sr-only"> active</span>
            </span>
          ) : null}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="dr-popover-positioner"
            align="start"
            sideOffset={4}
          >
            <Popover.Popup className="dr-popover dr-popover--wide">
              <FilterPanel
                type={type}
                filters={filters}
                onChange={onFiltersChange}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {sort ? (
        <p className="dr-sort-readout">
          <span>{sortLabel(type, sort)}</span>
          <button
            type="button"
            className="dr-icon-button"
            aria-label="Clear sort"
            onClick={onClearSort}
          >
            <Xmark aria-hidden="true" focusable="false" />
          </button>
        </p>
      ) : null}
      <SearchBox
        label={`Search ${type.namePlural.toLowerCase()}`}
        query={query}
        onQueryChange={onQueryChange}
      />
    </div>
  );
}
