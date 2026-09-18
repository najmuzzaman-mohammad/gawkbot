/**
 * URL state for the records table route. Sort, filter, page, search, and the
 * peek drawer all live in search params so a table view is a shareable link.
 *
 * Filter encoding: clauses joined by `,`, each `attribute.operator.value`
 * with the value run through `encodeURIComponent` (which escapes `,`, so the
 * separator is unambiguous). Value-less operators drop the third part:
 * `stage.equals.Pitched,check_size.greater.50000,email.is_empty`.
 */

import {
  DEFAULT_PAGE_SIZE,
  FILTER_OPERATORS,
  type FilterClause,
  type FilterOperator,
  PAGE_SIZE_OPTIONS,
  type RecordQuery,
} from "../api/dataspaces";

export interface DataTableSearch {
  sort?: string;
  dir?: "asc" | "desc";
  q?: string;
  page?: number;
  size?: number;
  peek?: string;
  filter?: string;
}

export const DEFAULT_PAGE = 1;
const CLAUSE_SEPARATOR = ",";
const PART_SEPARATOR = ".";
/** Attribute slugs, plus the `_`-prefixed system fields. */
const FIELD_PATTERN = /^_?[a-z0-9]+(_[a-z0-9]+)*$/;
const VALUELESS_OPERATORS: readonly FilterOperator[] = [
  "is_empty",
  "is_not_empty",
];

function isOperator(value: string): value is FilterOperator {
  return FILTER_OPERATORS.some((operator) => operator === value);
}

export function isValuelessOperator(operator: FilterOperator): boolean {
  return VALUELESS_OPERATORS.includes(operator);
}

export function encodeFilters(filters: readonly FilterClause[]): string {
  return filters
    .map((clause) => {
      const head = `${clause.attribute}${PART_SEPARATOR}${clause.operator}`;
      if (isValuelessOperator(clause.operator)) return head;
      return `${head}${PART_SEPARATOR}${encodeURIComponent(clause.value ?? "")}`;
    })
    .join(CLAUSE_SEPARATOR);
}

function decodeClause(raw: string): FilterClause | null {
  const [attribute, operator, ...rest] = raw.split(PART_SEPARATOR);
  if (!(attribute && operator)) return null;
  if (!(FIELD_PATTERN.test(attribute) && isOperator(operator))) return null;
  if (isValuelessOperator(operator)) {
    return rest.length === 0 ? { attribute, operator } : null;
  }
  if (rest.length === 0) return null;
  try {
    const value = decodeURIComponent(rest.join(PART_SEPARATOR));
    return { attribute, operator, value };
  } catch {
    // A malformed percent escape; treated like any other garbage.
    return null;
  }
}

/** All or nothing: one malformed clause yields `[]`, never a partial filter. */
export function decodeFilters(encoded: unknown): FilterClause[] {
  if (typeof encoded !== "string" || encoded === "") return [];
  const clauses = encoded.split(CLAUSE_SEPARATOR).map(decodeClause);
  if (clauses.some((clause) => clause === null)) return [];
  return clauses.filter((clause): clause is FilterClause => clause !== null);
}

function parseText(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseWholeNumber(raw: unknown): number | undefined {
  const text = parseText(raw);
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Normalizes raw search params. Defaults are omitted rather than written
 * out, so a clean table has a clean URL.
 */
export function parseDataTableSearch(
  search: Record<string, unknown>,
): DataTableSearch {
  const sort = parseText(search.sort);
  const dir =
    search.dir === "desc" || search.dir === "asc" ? search.dir : undefined;
  const page = parseWholeNumber(search.page);
  const size = parseWholeNumber(search.size);
  const filters = decodeFilters(search.filter);
  const hasSort = sort !== undefined && FIELD_PATTERN.test(sort);
  const hasSize =
    size !== undefined &&
    size !== DEFAULT_PAGE_SIZE &&
    PAGE_SIZE_OPTIONS.some((option) => option === size);
  const q = parseText(search.q);
  const peek = parseText(search.peek);

  return {
    ...(hasSort ? { sort } : {}),
    ...(hasSort && dir ? { dir } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(page !== undefined && page > DEFAULT_PAGE ? { page } : {}),
    ...(hasSize ? { size } : {}),
    ...(peek !== undefined ? { peek } : {}),
    ...(filters.length > 0 ? { filter: encodeFilters(filters) } : {}),
  };
}

export function toRecordQuery(
  typeId: string,
  search: DataTableSearch,
): RecordQuery {
  const parsed = parseDataTableSearch({ ...search });
  const limit = parsed.size ?? DEFAULT_PAGE_SIZE;
  const page = parsed.page ?? DEFAULT_PAGE;
  const filters = decodeFilters(parsed.filter);
  return {
    typeId,
    ...(filters.length > 0 ? { filters } : {}),
    ...(parsed.sort
      ? { sort: { attribute: parsed.sort, direction: parsed.dir ?? "asc" } }
      : {}),
    ...(parsed.q ? { query: parsed.q } : {}),
    limit,
    offset: (page - 1) * limit,
  };
}
