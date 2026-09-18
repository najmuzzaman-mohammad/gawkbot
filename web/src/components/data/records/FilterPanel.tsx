import { useEffect, useId, useRef, useState } from "react";
import { Plus, Xmark } from "iconoir-react";

import {
  FILTER_OPERATORS,
  type FilterClause,
  type FilterOperator,
  type ObjectType,
} from "../../../api/dataspaces";
import { isValuelessOperator } from "../../../lib/dataTableSearch";
import { Button } from "../DataButton";
import {
  clausesToRows,
  type FilterField,
  type FilterRow,
  filterFields,
  findFilterField,
  newFilterRow,
  OPERATOR_LABELS,
  rowsToClauses,
  sameClauses,
  TOGGLE_FILTER_VALUES,
  withField,
  withOperator,
} from "./filterRows";
import { useDebouncedValue } from "./useDebouncedValue";

import "../../../styles/data-records.css";

const COMMIT_DEBOUNCE_MS = 250;

export interface FilterPanelProps {
  type: ObjectType;
  /** The filters in the URL right now. */
  filters: readonly FilterClause[];
  onChange: (filters: readonly FilterClause[]) => void;
}

function isOperator(value: string): value is FilterOperator {
  return FILTER_OPERATORS.some((operator) => operator === value);
}

interface ValueInputProps {
  field: FilterField;
  row: FilterRow;
  label: string;
  onChange: (value: string) => void;
}

function FilterValueInput({ field, row, label, onChange }: ValueInputProps) {
  if (field.valueInput === "options" || field.valueInput === "toggle") {
    const choices =
      field.valueInput === "toggle"
        ? TOGGLE_FILTER_VALUES
        : field.optionNames.map((name) => ({ value: name, label: name }));
    return (
      <select
        className="dr-filter-control"
        aria-label={label}
        value={row.value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a value</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="dr-filter-control"
      type={field.valueInput === "date" ? "date" : "text"}
      inputMode={field.valueInput === "number" ? "decimal" : undefined}
      aria-label={label}
      placeholder="Value"
      autoComplete="off"
      value={row.value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * Filter rows: attribute, operator, value. Rows are drafts held here; only
 * complete rows are written to the URL, a beat after the last keystroke.
 * The panel mounts when its popover opens, so it starts from the URL.
 */
export function FilterPanel({ type, filters, onChange }: FilterPanelProps) {
  const headingId = useId();
  const keyCounter = useRef(0);
  const mintKey = () => {
    keyCounter.current += 1;
    return `filter-row-${keyCounter.current}`;
  };
  const fields = filterFields(type);
  const [rows, setRows] = useState<readonly FilterRow[]>(() =>
    clausesToRows(filters, fields, mintKey),
  );
  const settledRows = useDebouncedValue(rows, COMMIT_DEBOUNCE_MS);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const next = rowsToClauses(settledRows);
    if (!sameClauses(next, filtersRef.current)) onChangeRef.current(next);
  }, [settledRows]);

  // Closing the popover inside the debounce window must not drop the edit.
  useEffect(
    () => () => {
      const next = rowsToClauses(rowsRef.current);
      if (!sameClauses(next, filtersRef.current)) onChangeRef.current(next);
    },
    [],
  );

  const replaceRow = (key: string, change: (row: FilterRow) => FilterRow) =>
    setRows((current) =>
      current.map((row) => (row.key === key ? change(row) : row)),
    );

  const addRow = () => {
    const row = newFilterRow(fields, mintKey());
    if (row) setRows((current) => [...current, row]);
  };

  const clearAll = () => {
    setRows([]);
    // Immediate, not debounced: the button should feel final.
    if (filtersRef.current.length > 0) onChange([]);
  };

  return (
    <section className="dr-filter-panel" aria-labelledby={headingId}>
      <header className="dr-filter-panel-head">
        <h2 id={headingId} className="dr-filter-panel-title">
          Filters
        </h2>
        {rows.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={clearAll}>
            Clear all
          </Button>
        ) : null}
      </header>
      {rows.length === 0 ? (
        <p className="dr-filter-panel-empty">
          No filters yet. Add one to narrow the table.
        </p>
      ) : (
        <ul className="dr-filter-rows">
          {rows.map((row, index) => {
            const field = findFilterField(fields, row.field) ?? fields[0];
            const position = index + 1;
            return (
              <li key={row.key} className="dr-filter-row">
                <select
                  className="dr-filter-control"
                  aria-label={`Filter ${position} attribute`}
                  value={row.field}
                  onChange={(event) =>
                    replaceRow(row.key, (current) =>
                      withField(current, fields, event.target.value),
                    )
                  }
                >
                  {fields.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <select
                  className="dr-filter-control"
                  aria-label={`Filter ${position} operator`}
                  value={row.operator}
                  onChange={(event) => {
                    const operator = event.target.value;
                    if (!isOperator(operator)) return;
                    replaceRow(row.key, (current) =>
                      withOperator(current, operator),
                    );
                  }}
                >
                  {field.operators.map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_LABELS[operator]}
                    </option>
                  ))}
                </select>
                {isValuelessOperator(row.operator) ? (
                  <span className="dr-filter-novalue" aria-hidden="true" />
                ) : (
                  <FilterValueInput
                    field={field}
                    row={row}
                    label={`Filter ${position} value`}
                    onChange={(value) =>
                      replaceRow(row.key, (current) => ({ ...current, value }))
                    }
                  />
                )}
                <button
                  type="button"
                  className="dr-icon-button"
                  aria-label={`Remove filter ${position}`}
                  onClick={() =>
                    setRows((current) =>
                      current.filter((item) => item.key !== row.key),
                    )
                  }
                >
                  <Xmark aria-hidden="true" focusable="false" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="outline" size="sm" onClick={addRow}>
        <Plus aria-hidden="true" focusable="false" />
        Add filter
      </Button>
    </section>
  );
}
