import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { OnChangeFn, RowSelectionState } from "@tanstack/react-table";
import { Plus, Settings } from "iconoir-react";

import {
  type DataRecord,
  DEFAULT_PAGE_SIZE,
  type ObjectType,
  type RecordPage,
  type SpaceSchema,
} from "../../../api/dataspaces";
import { useRecordPage, useSpaceSchema } from "../../../hooks/useDataSpaces";
import { DEFAULT_PAGE, toRecordQuery } from "../../../lib/dataTableSearch";
import { showNotice } from "../../ui/Toast";
import { Button } from "../DataButton";
import { DataEmptyState } from "../DataEmptyState";
import { type DataCrumb, DataPageHeader } from "../DataPageHeader";
import { DeletePreviewDialog } from "../DeletePreviewDialog";
import { objectTypeIcon } from "../values/attributeTypeIcon";
import { NewRecordDialog } from "./NewRecordDialog";
import { lastPageFor, PaginationFooter } from "./PaginationFooter";
import { PeekDrawer } from "./PeekDrawer";
import { RecordsSkeleton } from "./RecordsSkeleton";
import { RecordsTable, type TableSort } from "./RecordsTable";
import { RecordsToolbar } from "./RecordsToolbar";
import { recordName } from "./recordModel";
import { SelectionToolbar } from "./SelectionToolbar";
import { useColumnPrefs } from "./useColumnPrefs";
import { attributeColumnSlugs } from "./useRecordsTable";
import { useTableSearch } from "./useTableSearch";
import { useValueCommit } from "./useValueCommit";

import "../../../styles/data.css";
import "../../../styles/data-records.css";

export interface RecordsPageProps {
  spaceId: string;
  typeSlug: string;
}

const DATA_CRUMB: DataCrumb = { label: "Data", to: "/data" };
const NO_SELECTION: RowSelectionState = {};

function deleteSubject(
  ids: readonly string[],
  records: readonly DataRecord[],
  type: ObjectType,
): string {
  if (ids.length === 1) {
    const record = records.find((item) => item.id === ids[0]);
    return record
      ? recordName(record, type)
      : `this ${type.name.toLowerCase()}`;
  }
  return `${ids.length.toLocaleString()} ${type.namePlural.toLowerCase()}`;
}

interface RecordsBodyProps {
  type: ObjectType;
  ownerSlug: string;
  page: UseQueryResult<RecordPage, Error>;
  /** Filters or search text are active. */
  isNarrowed: boolean;
  onClearNarrowing: () => void;
  addButton: ReactNode;
  /** The table and its footer, shown once there are rows. */
  children: ReactNode;
}

/** Which of the table's states is on screen: loading, error, empty, rows. */
function RecordsBody({
  type,
  ownerSlug,
  page,
  isNarrowed,
  onClearNarrowing,
  addButton,
  children,
}: RecordsBodyProps) {
  const plural = type.namePlural.toLowerCase();
  if (page.isPending) {
    return <RecordsSkeleton label={`Loading ${plural}`} />;
  }
  const clearButton = (
    <Button variant="outline" onClick={onClearNarrowing}>
      Clear filters
    </Button>
  );
  if (page.isError) {
    return (
      <DataEmptyState
        title={`${type.namePlural} could not be loaded`}
        body={page.error.message}
        action={
          isNarrowed ? (
            clearButton
          ) : (
            <Button variant="outline" onClick={() => void page.refetch()}>
              Try again
            </Button>
          )
        }
      />
    );
  }
  if (page.data.records.length > 0) return children;
  // Rows exist but not on this page: the page is past the end and is about
  // to be corrected, so this is still loading, not empty.
  if (page.data.total > 0) {
    return <RecordsSkeleton label={`Loading ${plural}`} />;
  }
  if (isNarrowed) {
    return (
      <DataEmptyState
        title={`No ${plural} match`}
        body="Nothing fits the current filters and search."
        action={clearButton}
      />
    );
  }
  return (
    <DataEmptyState
      title={`No ${plural} yet`}
      body={`Ask @${ownerSlug} to add some, or add one yourself.`}
      action={addButton}
    />
  );
}

interface ScopedSelection {
  viewKey: string;
  rows: RowSelectionState;
}

interface RecordsViewProps {
  schema: SpaceSchema;
  type: ObjectType;
}

function RecordsView({ schema, type }: RecordsViewProps) {
  const { space, objectTypes } = schema;
  const spaceId = space.id;
  const { search, filters, actions } = useTableSearch();
  const page = useRecordPage(spaceId, toRecordQuery(type.id, search));
  const columnPrefs = useColumnPrefs(
    spaceId,
    type.id,
    attributeColumnSlugs(type),
  );
  const { pending: pendingValue, commit } = useValueCommit(spaceId);
  const [deleteIds, setDeleteIds] = useState<readonly string[] | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const pageNumber = search.page ?? DEFAULT_PAGE;
  const pageSize = search.size ?? DEFAULT_PAGE_SIZE;
  const total = page.data?.total;
  const records = page.data?.records ?? [];
  const sort: TableSort | null = search.sort
    ? { attribute: search.sort, direction: search.dir ?? "asc" }
    : null;
  const isNarrowed = filters.length > 0 || (search.q ?? "") !== "";
  // A selection the operator cannot see must never reach Delete, so it is
  // scoped to the exact view (sort, filter, search, page) it was made in.
  const viewKey = [
    search.sort,
    search.dir,
    search.q,
    search.filter,
    pageNumber,
    pageSize,
  ].join("|");
  const [selection, setSelection] = useState<ScopedSelection>({
    viewKey,
    rows: NO_SELECTION,
  });
  const rowSelection =
    selection.viewKey === viewKey ? selection.rows : NO_SELECTION;
  const setRowSelection = useCallback<OnChangeFn<RowSelectionState>>(
    (updater) =>
      setSelection((current) => {
        const base = current.viewKey === viewKey ? current.rows : NO_SELECTION;
        const rows = typeof updater === "function" ? updater(base) : updater;
        return { viewKey, rows };
      }),
    [viewKey],
  );
  const selectedIds = Object.keys(rowSelection).filter(
    (id) => rowSelection[id],
  );

  // After a delete or a tighter filter the page can sit past the end.
  const { setPage } = actions;
  useEffect(() => {
    if (total === undefined || page.isPlaceholderData) return;
    const lastPage = lastPageFor(total, pageSize);
    if (pageNumber > lastPage) setPage(lastPage, { replace: true });
  }, [total, page.isPlaceholderData, pageNumber, pageSize, setPage]);

  const { setPeek } = actions;
  const handlePreview = useCallback(
    (recordId: string) => setPeek(recordId),
    [setPeek],
  );

  const TypeIcon = objectTypeIcon(type.icon);
  const crumbs: readonly DataCrumb[] = [
    DATA_CRUMB,
    { label: space.name, to: "/data/$spaceId", params: { spaceId } },
    { label: type.namePlural },
  ];
  const addButton = (
    <Button onClick={() => setIsAdding(true)}>
      <Plus aria-hidden="true" focusable="false" />
      Add {type.name}
    </Button>
  );

  return (
    <>
      <DataPageHeader
        crumbs={crumbs}
        title={type.namePlural}
        icon={<TypeIcon aria-hidden="true" focusable="false" />}
        subtitle={type.description === "" ? undefined : type.description}
        actions={
          <>
            <Button variant="outline" asChild={true}>
              <Link
                to="/data/$spaceId/t/$typeSlug/settings"
                params={{ spaceId, typeSlug: type.slug }}
              >
                <Settings aria-hidden="true" focusable="false" />
                Settings
              </Link>
            </Button>
            {addButton}
          </>
        }
      />
      <div className="dr-region">
        <RecordsToolbar
          type={type}
          filters={filters}
          onFiltersChange={actions.setFilters}
          sort={sort}
          onClearSort={actions.clearSort}
          query={search.q ?? ""}
          onQueryChange={actions.setQuery}
        />
        <SelectionToolbar
          count={selectedIds.length}
          onDelete={() => setDeleteIds(selectedIds)}
          onClear={() => setRowSelection(NO_SELECTION)}
        />
        <RecordsBody
          type={type}
          ownerSlug={space.owner}
          page={page}
          isNarrowed={isNarrowed}
          onClearNarrowing={actions.clearFiltersAndQuery}
          addButton={addButton}
        >
          <RecordsTable
            spaceId={spaceId}
            type={type}
            objectTypes={objectTypes}
            records={records}
            sort={sort}
            onSort={actions.setSort}
            columnPrefs={columnPrefs}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            pendingValue={pendingValue}
            onCommitValue={commit}
            onPreview={handlePreview}
            onDelete={(recordId) => setDeleteIds([recordId])}
            isFetching={page.isFetching}
          />
          <PaginationFooter
            page={pageNumber}
            pageSize={pageSize}
            total={total ?? 0}
            onPageChange={actions.setPage}
            onPageSizeChange={actions.setPageSize}
          />
        </RecordsBody>
      </div>
      <NewRecordDialog
        spaceId={spaceId}
        type={type}
        open={isAdding}
        onClose={() => setIsAdding(false)}
        onCreated={(record) => {
          setIsAdding(false);
          showNotice(`Added ${recordName(record, type)}.`, "success");
          actions.setPeek(record.id);
        }}
      />
      <DeletePreviewDialog
        spaceId={spaceId}
        kind="records"
        ids={deleteIds ?? []}
        subjectLabel={deleteSubject(deleteIds ?? [], records, type)}
        open={deleteIds !== null}
        onClose={() => setDeleteIds(null)}
        onDeleted={() => {
          setRowSelection(NO_SELECTION);
          showNotice("Deleted.", "success");
        }}
      />
      <PeekDrawer
        spaceId={spaceId}
        recordId={search.peek ?? null}
        objectTypes={objectTypes}
        onClose={() => actions.setPeek(null)}
      />
    </>
  );
}

/**
 * Records table for one object type. Resolves the type by slug from the
 * space schema; everything about the view (sort, filter, search, page, peek)
 * is URL state, and only column preferences live in localStorage.
 */
export function RecordsPage({ spaceId, typeSlug }: RecordsPageProps) {
  const schema = useSpaceSchema(spaceId);

  if (schema.isPending) {
    return (
      <>
        <DataPageHeader
          crumbs={[DATA_CRUMB, { label: "Loading" }]}
          title="Loading"
        />
        <RecordsSkeleton label="Loading records" />
      </>
    );
  }

  if (schema.isError) {
    return (
      <>
        <DataPageHeader
          crumbs={[DATA_CRUMB, { label: "Not found" }]}
          title="Data space not found"
        />
        <DataEmptyState
          title="This data space does not exist"
          body="It may have been deleted, or the link is wrong."
          action={
            <Button variant="outline" asChild={true}>
              <Link to="/data">Back to Data</Link>
            </Button>
          }
        />
      </>
    );
  }

  const type = schema.data.objectTypes.find((item) => item.slug === typeSlug);
  if (!type) {
    const { space } = schema.data;
    return (
      <>
        <DataPageHeader
          crumbs={[
            DATA_CRUMB,
            {
              label: space.name,
              to: "/data/$spaceId",
              params: { spaceId: space.id },
            },
            { label: "Not found" },
          ]}
          title="Object type not found"
        />
        <DataEmptyState
          title="This object type does not exist"
          body={`${space.name} has no object type with the slug "${typeSlug}".`}
          action={
            <Button variant="outline" asChild={true}>
              <Link to="/data/$spaceId" params={{ spaceId: space.id }}>
                Back to {space.name}
              </Link>
            </Button>
          }
        />
      </>
    );
  }

  // Keyed by type so selection and dialogs never leak between tables.
  return <RecordsView key={type.id} schema={schema.data} type={type} />;
}
