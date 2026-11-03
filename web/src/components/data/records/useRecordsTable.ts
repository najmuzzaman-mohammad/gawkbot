import { useMemo } from "react";
import {
  type ColumnDef,
  getCoreRowModel,
  type OnChangeFn,
  type RowSelectionState,
  type Table,
  useReactTable,
} from "@tanstack/react-table";

import type {
  AttributeDefinition,
  DataRecord,
  ObjectType,
} from "../../../api/dataspaces";
import type { ColumnPrefs } from "./columnPrefs";
import { primaryAttributeOf } from "./recordModel";

export const SELECT_COLUMN_ID = "_select";
export const UPDATED_COLUMN_ID = "_updated_at";
export const ACTIONS_COLUMN_ID = "_actions";

/**
 * What a column IS. The table hook owns the column model (ids, order,
 * visibility, selection); the view looks the descriptor up by column id and
 * decides how to draw it, so this file stays free of JSX.
 */
export type ColumnDescriptor =
  | { kind: "select" }
  | { kind: "name"; attribute: AttributeDefinition }
  | { kind: "attribute"; attribute: AttributeDefinition }
  | { kind: "updated" }
  | { kind: "actions" };

export interface UseRecordsTableOptions {
  type: ObjectType;
  records: readonly DataRecord[];
  prefs: ColumnPrefs;
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
}

export interface RecordsTableModel {
  table: Table<DataRecord>;
  descriptors: ReadonlyMap<string, ColumnDescriptor>;
  /** Attributes the operator has hidden, in schema order. */
  hiddenAttributes: readonly AttributeDefinition[];
}

/** Non-primary attributes, in schema order: the movable, hideable columns. */
export function attributeColumnSlugs(type: ObjectType): string[] {
  return type.attributes
    .filter((attribute) => !attribute.isPrimary)
    .map((attribute) => attribute.slug);
}

function displayColumn(id: string): ColumnDef<DataRecord> {
  return { id, header: id, enableSorting: false };
}

/**
 * TanStack Table v8 as the column model. Sorting, filtering, and pagination
 * are server side (the URL drives the query), so only the core row model is
 * used; the table contributes column order, visibility, and row selection.
 */
export function useRecordsTable({
  type,
  records,
  prefs,
  rowSelection,
  onRowSelectionChange,
}: UseRecordsTableOptions): RecordsTableModel {
  const descriptors = useMemo(() => {
    const map = new Map<string, ColumnDescriptor>();
    map.set(SELECT_COLUMN_ID, { kind: "select" });
    const primary = primaryAttributeOf(type);
    if (primary) map.set(primary.slug, { kind: "name", attribute: primary });
    for (const attribute of type.attributes) {
      if (!attribute.isPrimary) {
        map.set(attribute.slug, { kind: "attribute", attribute });
      }
    }
    map.set(UPDATED_COLUMN_ID, { kind: "updated" });
    map.set(ACTIONS_COLUMN_ID, { kind: "actions" });
    return map;
  }, [type]);

  const columns = useMemo(
    () => [...descriptors.keys()].map(displayColumn),
    [descriptors],
  );

  const columnOrder = useMemo(() => {
    const primarySlug = primaryAttributeOf(type)?.slug;
    return [
      SELECT_COLUMN_ID,
      ...(primarySlug ? [primarySlug] : []),
      ...prefs.order,
      UPDATED_COLUMN_ID,
      ACTIONS_COLUMN_ID,
    ];
  }, [prefs.order, type]);

  const columnVisibility = useMemo(
    () => Object.fromEntries(prefs.hidden.map((slug) => [slug, false])),
    [prefs.hidden],
  );

  // Records arrive readonly from the query cache; the table never mutates.
  const data = useMemo(() => [...records], [records]);

  const table = useReactTable<DataRecord>({
    data,
    columns,
    state: { rowSelection, columnOrder, columnVisibility },
    onRowSelectionChange,
    getRowId: (record) => record.id,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: true,
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
  });

  const hiddenAttributes = useMemo(() => {
    const hidden = new Set(prefs.hidden);
    return type.attributes.filter((attribute) => hidden.has(attribute.slug));
  }, [prefs.hidden, type]);

  return { table, descriptors, hiddenAttributes };
}
