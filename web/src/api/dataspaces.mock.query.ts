/**
 * Filter, search, sort, and pagination for the in-memory data client.
 *
 * Besides attribute slugs, filters and sorts accept three system fields. They
 * start with `_`, which no attribute slug can, so they never collide.
 */

import {
  type AttributeDefinition,
  type DataRecord,
  FILTER_OPERATORS,
  type FilterClause,
  type ObjectType,
  type RecordPage,
  type RecordQuery,
} from "./dataspaces";
import {
  createRecordViewer,
  fail,
  requireType,
  type SpaceState,
} from "./dataspaces.mock.store";

export const SYSTEM_FIELDS = [
  "_created_at",
  "_updated_at",
  "_created_by",
] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];
export const MAX_QUERY_LIMIT = 1000;

const NUMERIC_TYPES: readonly string[] = ["number", "currency", "rating"];
const SEARCHED_TYPES: readonly string[] = [
  "text",
  "email",
  "url",
  "phone",
  "select",
  "status",
];
const VALUELESS_OPERATORS: readonly string[] = ["is_empty", "is_not_empty"];

type Field =
  | { kind: "system"; slug: SystemField }
  | { kind: "attribute"; attribute: AttributeDefinition };

function isSystemField(slug: string): slug is SystemField {
  return SYSTEM_FIELDS.some((field) => field === slug);
}

function resolveField(type: ObjectType, slug: string): Field {
  if (isSystemField(slug)) return { kind: "system", slug };
  const attribute = type.attributes.find((item) => item.slug === slug);
  if (!attribute) {
    const slugs = type.attributes.map((item) => item.slug).join(", ");
    return fail(
      `"${slug}" is not an attribute of ${type.name}. Valid attributes: ${slugs}.`,
      slug,
    );
  }
  return { kind: "attribute", attribute };
}

function systemValue(record: DataRecord, slug: SystemField): string {
  if (slug === "_created_at") return record.createdAt;
  if (slug === "_updated_at") return record.updatedAt;
  return record.createdBy;
}

/** What a person sees in the cell: option names, linked record names. */
function displayValues(record: DataRecord, field: Field): string[] {
  if (field.kind === "system") return [systemValue(record, field.slug)];
  const { attribute } = field;
  if (attribute.type === "relationship") {
    return (record.links[attribute.slug] ?? []).map((ref) => ref.name);
  }
  const raw = record.values[attribute.slug];
  if (raw === undefined) return [];
  const items = typeof raw === "object" ? [...raw] : [raw];
  if (attribute.type === "select" || attribute.type === "status") {
    return items.map((id) => {
      const option = attribute.options.find((item) => item.id === id);
      return option ? option.name : String(id);
    });
  }
  return items.map(String);
}

function isNumeric(field: Field): boolean {
  return (
    field.kind === "attribute" && NUMERIC_TYPES.includes(field.attribute.type)
  );
}

function isToggle(field: Field): boolean {
  return field.kind === "attribute" && field.attribute.type === "toggle";
}

function numericOperand(clause: FilterClause): number {
  const parsed = Number((clause.value ?? "").trim());
  if ((clause.value ?? "").trim() === "" || !Number.isFinite(parsed)) {
    return fail(
      `Filter on "${clause.attribute}" needs a number; got "${clause.value ?? ""}".`,
      clause.attribute,
    );
  }
  return parsed;
}

function matchesClause(
  record: DataRecord,
  field: Field,
  clause: FilterClause,
): boolean {
  const shown = displayValues(record, field);
  if (clause.operator === "is_empty") return shown.length === 0;
  if (clause.operator === "is_not_empty") return shown.length > 0;

  const wanted = (clause.value ?? "").trim().toLowerCase();
  // An unset toggle reads as "false", the same way the table renders it.
  const values = isToggle(field) && shown.length === 0 ? ["false"] : shown;
  const lowered = values.map((value) => value.trim().toLowerCase());

  switch (clause.operator) {
    case "equals":
    case "not_equals": {
      const isEqual = isNumeric(field)
        ? values.some((value) => Number(value) === numericOperand(clause))
        : lowered.includes(wanted);
      return clause.operator === "equals" ? isEqual : !isEqual;
    }
    case "contains":
      return lowered.some((value) => value.includes(wanted));
    case "greater":
    case "less": {
      const isGreater = clause.operator === "greater";
      if (isNumeric(field)) {
        const operand = numericOperand(clause);
        return values.some((value) =>
          isGreater ? Number(value) > operand : Number(value) < operand,
        );
      }
      // Dates are YYYY-MM-DD, so a plain string compare orders them.
      return lowered.some((value) =>
        isGreater ? value > wanted : value < wanted,
      );
    }
    default:
      return fail(`Unknown filter operator "${clause.operator}".`);
  }
}

function assertClause(clause: FilterClause) {
  if (!FILTER_OPERATORS.includes(clause.operator)) {
    fail(
      `"${clause.operator}" is not a filter operator. Valid: ${FILTER_OPERATORS.join(", ")}.`,
      clause.attribute,
    );
  }
  const needsValue = !VALUELESS_OPERATORS.includes(clause.operator);
  if (needsValue && clause.value === undefined) {
    fail(
      `Filter "${clause.operator}" on "${clause.attribute}" needs a value.`,
      clause.attribute,
    );
  }
}

function matchesSearch(
  record: DataRecord,
  type: ObjectType,
  needle: string,
): boolean {
  return type.attributes
    .filter((item) => item.isPrimary || SEARCHED_TYPES.includes(item.type))
    .flatMap((attribute) =>
      displayValues(record, { kind: "attribute", attribute }),
    )
    .some((value) => value.toLowerCase().includes(needle));
}

type SortKey = string | number | null;

function sortKey(record: DataRecord, field: Field): SortKey {
  if (field.kind === "system") {
    return systemValue(record, field.slug).toLowerCase();
  }
  const { attribute } = field;
  const raw = record.values[attribute.slug];
  if (raw === undefined) return null;
  if (attribute.type === "select" || attribute.type === "status") {
    const ids = typeof raw === "object" ? [...raw] : [String(raw)];
    const positions = ids
      .map((id) => attribute.options.findIndex((option) => option.id === id))
      .filter((index) => index >= 0);
    return positions.length > 0 ? Math.min(...positions) : null;
  }
  if (typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "object") return raw.join(", ").toLowerCase();
  return raw.toLowerCase();
}

function compareKeys(a: SortKey, b: SortKey, direction: 1 | -1): number {
  // Empty values sink to the bottom whichever way the column is sorted.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a === b) return 0;
  return (a < b ? -1 : 1) * direction;
}

export function queryRecords(
  state: SpaceState,
  query: RecordQuery,
): RecordPage {
  const type = requireType(state, query.typeId);
  if (!Number.isInteger(query.limit) || query.limit < 1) {
    fail(`limit must be a whole number of at least 1; got ${query.limit}.`);
  }
  if (query.limit > MAX_QUERY_LIMIT) {
    fail(`limit cannot exceed ${MAX_QUERY_LIMIT}; got ${query.limit}.`);
  }
  if (!Number.isInteger(query.offset) || query.offset < 0) {
    fail(`offset must be a whole number of at least 0; got ${query.offset}.`);
  }

  const clauses = (query.filters ?? []).map((clause) => {
    assertClause(clause);
    return { clause, field: resolveField(type, clause.attribute) };
  });
  const sortField = query.sort
    ? resolveField(type, query.sort.attribute)
    : null;
  if (
    sortField?.kind === "attribute" &&
    sortField.attribute.type === "relationship"
  ) {
    fail(
      `Records cannot be sorted by the relationship "${sortField.attribute.slug}".`,
      sortField.attribute.slug,
    );
  }

  const view = createRecordViewer(state);
  const needle = (query.query ?? "").trim().toLowerCase();
  let rows = state.records
    .filter((record) => record.typeId === type.id)
    .map(view)
    .filter((record) =>
      clauses.every(({ clause, field }) =>
        matchesClause(record, field, clause),
      ),
    )
    .filter((record) => needle === "" || matchesSearch(record, type, needle));

  if (sortField && query.sort) {
    const direction = query.sort.direction === "desc" ? -1 : 1;
    const keyed = rows.map((record, index) => ({
      record,
      index,
      key: sortKey(record, sortField),
    }));
    // The index tie-break keeps creation order among equal keys.
    keyed.sort(
      (a, b) => compareKeys(a.key, b.key, direction) || a.index - b.index,
    );
    rows = keyed.map((item) => item.record);
  }

  return {
    records: rows.slice(query.offset, query.offset + query.limit),
    total: rows.length,
  };
}
