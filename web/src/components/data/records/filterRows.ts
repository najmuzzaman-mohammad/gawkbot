/**
 * Pure helpers behind the filter panel. A panel row is a draft: it can be
 * half filled in while the operator is still choosing. Only complete rows
 * become `FilterClause`s and reach the URL, so a shared link never carries a
 * filter the store would reject for having no value.
 */

import type {
  AttributeDefinition,
  AttributeType,
  FilterClause,
  FilterOperator,
  ObjectType,
} from "../../../api/dataspaces";
import { isValuelessOperator } from "../../../lib/dataTableSearch";

export type FilterValueInput =
  | "text"
  | "number"
  | "date"
  | "options"
  | "toggle";

export interface FilterField {
  /** Attribute slug, or a `_`-prefixed system field. */
  slug: string;
  label: string;
  operators: readonly FilterOperator[];
  valueInput: FilterValueInput;
  /** Option NAMES: the store compares select and status by display value. */
  optionNames: readonly string[];
}

export interface FilterRow {
  /** Stable React key; never sent anywhere. */
  key: string;
  field: string;
  operator: FilterOperator;
  value: string;
}

export const OPERATOR_LABELS: Readonly<Record<FilterOperator, string>> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  greater: "is greater than",
  less: "is less than",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

export const TOGGLE_FILTER_VALUES = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
] as const;

const EMPTINESS: readonly FilterOperator[] = ["is_empty", "is_not_empty"];
const TEXT_OPERATORS: readonly FilterOperator[] = [
  "contains",
  "equals",
  "not_equals",
  ...EMPTINESS,
];
const ORDERED_OPERATORS: readonly FilterOperator[] = [
  "equals",
  "not_equals",
  "greater",
  "less",
  ...EMPTINESS,
];
const OPTION_OPERATORS: readonly FilterOperator[] = [
  "equals",
  "not_equals",
  ...EMPTINESS,
];

interface FieldShape {
  operators: readonly FilterOperator[];
  valueInput: FilterValueInput;
}

const SHAPE_BY_TYPE: Readonly<Record<AttributeType, FieldShape>> = {
  text: { operators: TEXT_OPERATORS, valueInput: "text" },
  url: { operators: TEXT_OPERATORS, valueInput: "text" },
  email: { operators: TEXT_OPERATORS, valueInput: "text" },
  phone: { operators: TEXT_OPERATORS, valueInput: "text" },
  number: { operators: ORDERED_OPERATORS, valueInput: "number" },
  currency: { operators: ORDERED_OPERATORS, valueInput: "number" },
  rating: { operators: ORDERED_OPERATORS, valueInput: "number" },
  date: { operators: ORDERED_OPERATORS, valueInput: "date" },
  toggle: { operators: ["equals"], valueInput: "toggle" },
  select: { operators: OPTION_OPERATORS, valueInput: "options" },
  status: { operators: OPTION_OPERATORS, valueInput: "options" },
  // Relationship filters compare against the linked records' names.
  relationship: {
    operators: ["contains", "equals", ...EMPTINESS],
    valueInput: "text",
  },
};

const SYSTEM_FILTER_FIELDS: readonly FilterField[] = [
  {
    slug: "_created_at",
    label: "Created",
    operators: ["greater", "less"],
    valueInput: "date",
    optionNames: [],
  },
  {
    slug: "_updated_at",
    label: "Updated",
    operators: ["greater", "less"],
    valueInput: "date",
    optionNames: [],
  },
  {
    slug: "_created_by",
    label: "Created by",
    operators: ["equals", "not_equals"],
    valueInput: "text",
    optionNames: [],
  },
];

function attributeField(attribute: AttributeDefinition): FilterField {
  const shape = SHAPE_BY_TYPE[attribute.type];
  return {
    slug: attribute.slug,
    label: attribute.name,
    operators: shape.operators,
    valueInput: shape.valueInput,
    optionNames: attribute.options.map((option) => option.name),
  };
}

/** Every attribute in schema order, then the system fields. */
export function filterFields(type: ObjectType): readonly FilterField[] {
  return [...type.attributes.map(attributeField), ...SYSTEM_FILTER_FIELDS];
}

export function findFilterField(
  fields: readonly FilterField[],
  slug: string,
): FilterField | undefined {
  return fields.find((field) => field.slug === slug);
}

export function newFilterRow(
  fields: readonly FilterField[],
  key: string,
): FilterRow | null {
  const [first] = fields;
  if (!first) return null;
  return { key, field: first.slug, operator: first.operators[0], value: "" };
}

/** Changing the field resets whatever no longer applies to it. */
export function withField(
  row: FilterRow,
  fields: readonly FilterField[],
  slug: string,
): FilterRow {
  const next = findFilterField(fields, slug);
  if (!next || next.slug === row.field) return row;
  const operator = next.operators.includes(row.operator)
    ? row.operator
    : next.operators[0];
  return { ...row, field: next.slug, operator, value: "" };
}

export function withOperator(
  row: FilterRow,
  operator: FilterOperator,
): FilterRow {
  if (operator === row.operator) return row;
  return {
    ...row,
    operator,
    value: isValuelessOperator(operator) ? "" : row.value,
  };
}

export function isCompleteRow(row: FilterRow): boolean {
  return isValuelessOperator(row.operator) || row.value.trim() !== "";
}

export function rowsToClauses(rows: readonly FilterRow[]): FilterClause[] {
  return rows.filter(isCompleteRow).map((row) =>
    isValuelessOperator(row.operator)
      ? { attribute: row.field, operator: row.operator }
      : {
          attribute: row.field,
          operator: row.operator,
          value: row.value.trim(),
        },
  );
}

/** Clauses naming a field this type no longer has are dropped. */
export function clausesToRows(
  clauses: readonly FilterClause[],
  fields: readonly FilterField[],
  mintKey: () => string,
): FilterRow[] {
  return clauses
    .filter((clause) => findFilterField(fields, clause.attribute) !== undefined)
    .map((clause) => ({
      key: mintKey(),
      field: clause.attribute,
      operator: clause.operator,
      value: clause.value ?? "",
    }));
}

export function sameClauses(
  left: readonly FilterClause[],
  right: readonly FilterClause[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((clause, index) => {
    const other = right[index];
    return (
      clause.attribute === other.attribute &&
      clause.operator === other.operator &&
      (clause.value ?? "") === (other.value ?? "")
    );
  });
}
