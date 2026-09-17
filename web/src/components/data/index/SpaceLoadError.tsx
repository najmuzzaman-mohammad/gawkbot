import { Link } from "@tanstack/react-router";

import { DataValidationError } from "../../../api/dataspaces";
import { DataEmptyState } from "../DataEmptyState";
import { type DataCrumb, DataPageHeader } from "../DataPageHeader";
import { errorMessage } from "../settings/formControls";

import "../../../styles/data-schema.css";

const ROOT_CRUMB: DataCrumb = { label: "Data", to: "/data" };

interface SpaceLoadErrorProps {
  error: unknown;
}

/**
 * A schema that failed to load. The store rejects an unknown space id with a
 * `DataValidationError`, which is the not-found case; anything else is a
 * load failure and says so, with the store's own message.
 */
export function SpaceLoadError({ error }: SpaceLoadErrorProps) {
  const isNotFound = error instanceof DataValidationError;
  return (
    <>
      <DataPageHeader
        crumbs={[ROOT_CRUMB, { label: isNotFound ? "Not found" : "Error" }]}
        title={isNotFound ? "Data space not found" : "Data space did not load"}
      />
      <DataEmptyState
        title={
          isNotFound
            ? "This data space does not exist"
            : "Something went wrong loading this space"
        }
        body={
          isNotFound
            ? "It may have been deleted, or the link may be wrong. Every space that exists is listed under Data."
            : errorMessage(error)
        }
        action={
          <Link className="data-list-action" to="/data">
            Back to Data
          </Link>
        }
      />
    </>
  );
}
