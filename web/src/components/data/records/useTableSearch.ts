import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { FilterClause, SortDirection } from "../../../api/dataspaces";
import {
  type DataTableSearch,
  decodeFilters,
  encodeFilters,
} from "../../../lib/dataTableSearch";
import { dataTypeRoute } from "../../../lib/router";

type SearchPatch = (previous: DataTableSearch) => DataTableSearch;

export interface TableSearchActions {
  setSort: (attribute: string, direction: SortDirection) => void;
  clearSort: () => void;
  /** Typing in the search box replaces history instead of stacking it. */
  setQuery: (query: string) => void;
  setFilters: (filters: readonly FilterClause[]) => void;
  /** Clears filters and the search text together. */
  clearFiltersAndQuery: () => void;
  setPage: (page: number, options?: { replace?: boolean }) => void;
  setPageSize: (size: number) => void;
  setPeek: (recordId: string | null) => void;
}

export interface TableSearchState {
  search: DataTableSearch;
  filters: readonly FilterClause[];
  actions: TableSearchActions;
}

/**
 * The records table's URL state. Sort, filter, search text, page, page size,
 * and the peek drawer all live in search params, so a table view is a link
 * that survives reload. Anything that changes the result set resets `page`.
 *
 * Defaults are written as `undefined`; the route's `validateSearch` drops
 * them, so a clean table keeps a clean URL.
 */
export function useTableSearch(): TableSearchState {
  const search = dataTypeRoute.useSearch();
  const navigate = useNavigate({ from: dataTypeRoute.fullPath });

  const update = useCallback(
    (patch: SearchPatch, replace = false) => {
      void navigate({ to: ".", search: patch, replace });
    },
    [navigate],
  );

  const actions = useMemo<TableSearchActions>(
    () => ({
      setSort: (attribute, direction) =>
        update((previous) => ({
          ...previous,
          sort: attribute,
          dir: direction,
          page: undefined,
        })),
      clearSort: () =>
        update((previous) => ({
          ...previous,
          sort: undefined,
          dir: undefined,
          page: undefined,
        })),
      setQuery: (query) =>
        update(
          (previous) => ({
            ...previous,
            q: query.trim() === "" ? undefined : query,
            page: undefined,
          }),
          true,
        ),
      // Filter values are typed too, so they replace history like search.
      setFilters: (next) =>
        update(
          (previous) => ({
            ...previous,
            filter: next.length === 0 ? undefined : encodeFilters(next),
            page: undefined,
          }),
          true,
        ),
      clearFiltersAndQuery: () =>
        update((previous) => ({
          ...previous,
          filter: undefined,
          q: undefined,
          page: undefined,
        })),
      setPage: (page, options) =>
        update(
          (previous) => ({ ...previous, page: page <= 1 ? undefined : page }),
          options?.replace ?? false,
        ),
      setPageSize: (size) =>
        update((previous) => ({ ...previous, size, page: undefined })),
      setPeek: (recordId) =>
        update((previous) => ({ ...previous, peek: recordId ?? undefined })),
    }),
    [update],
  );

  const filters = useMemo(() => decodeFilters(search.filter), [search.filter]);

  return { search, filters, actions };
}
