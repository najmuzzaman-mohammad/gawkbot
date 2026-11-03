import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import type { ObjectType } from "../../../api/dataspaces";
import { useSpaceSchema } from "../../../hooks/useDataSpaces";
import { DataEmptyState } from "../DataEmptyState";
import { type DataCrumb, DataPageHeader } from "../DataPageHeader";
import { SpaceLoadError } from "../index/SpaceLoadError";
import { objectTypeIcon } from "../values/attributeTypeIcon";
import { AttributesTab } from "./AttributesTab";
import { GeneralTab } from "./GeneralTab";

import "../../../styles/data-schema.css";

export type TypeSettingsTab = "general" | "attributes";

interface TypeSettingsPageProps {
  spaceId: string;
  typeSlug: string;
  tab: TypeSettingsTab;
}

const ROOT_CRUMB: DataCrumb = { label: "Data", to: "/data" };
const TABS: readonly { id: TypeSettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "attributes", label: "Attributes" },
];

/**
 * `/data/$spaceId/t/$typeSlug/settings?tab=`: settings of one object type.
 * The tabs are links that set the `tab` search param, so a tab is a URL.
 */
export function TypeSettingsPage({
  spaceId,
  typeSlug,
  tab,
}: TypeSettingsPageProps) {
  const schemaQuery = useSpaceSchema(spaceId);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const lastTypeRef = useRef<ObjectType | null>(null);
  const found =
    schemaQuery.data?.objectTypes.find((type) => type.slug === typeSlug) ??
    null;

  useEffect(() => {
    if (found) lastTypeRef.current = found;
  }, [found]);

  if (schemaQuery.isPending) {
    return (
      <>
        <DataPageHeader
          crumbs={[ROOT_CRUMB, { label: "Loading" }]}
          title="Settings"
        />
        <p className="data-page-status" aria-busy="true">
          Loading the object type…
        </p>
      </>
    );
  }

  if (schemaQuery.isError) {
    return <SpaceLoadError error={schemaQuery.error} />;
  }

  const { space, objectTypes } = schemaQuery.data;
  const spaceCrumb: DataCrumb = {
    label: space.name,
    to: "/data/$spaceId",
    params: { spaceId },
  };
  // While its own delete is in flight the type is already gone from the
  // refetched schema; keep showing it until the tab navigates away.
  const held =
    isDeleteOpen && lastTypeRef.current?.slug === typeSlug
      ? lastTypeRef.current
      : null;
  const objectType = found ?? held;

  if (objectType === null) {
    return (
      <>
        <DataPageHeader
          crumbs={[ROOT_CRUMB, spaceCrumb, { label: "Not found" }]}
          title="Object type not found"
        />
        <DataEmptyState
          title="This object type does not exist"
          body={`${space.name} has no object type with the slug "${typeSlug}". It may have been deleted.`}
          action={
            <Link
              className="data-list-action"
              to="/data/$spaceId"
              params={{ spaceId }}
            >
              Back to {space.name}
            </Link>
          }
        />
      </>
    );
  }

  const Icon = objectTypeIcon(objectType.icon);
  const typeParams = { spaceId, typeSlug: objectType.slug };

  return (
    <>
      <DataPageHeader
        crumbs={[
          ROOT_CRUMB,
          spaceCrumb,
          {
            label: objectType.namePlural,
            to: "/data/$spaceId/t/$typeSlug",
            params: typeParams,
          },
          { label: "Settings" },
        ]}
        title={`${objectType.name} settings`}
        icon={<Icon aria-hidden="true" focusable="false" />}
        actions={
          <Link
            className="data-list-action"
            to="/data/$spaceId/t/$typeSlug"
            params={typeParams}
          >
            Open {objectType.namePlural}
          </Link>
        }
      />
      <nav className="data-tabs" aria-label="Object type settings">
        {TABS.map((item) => (
          <Link
            key={item.id}
            className="data-tab"
            to="/data/$spaceId/t/$typeSlug/settings"
            params={typeParams}
            search={{ tab: item.id }}
            aria-current={item.id === tab ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {tab === "attributes" ? (
        <AttributesTab
          spaceId={spaceId}
          objectType={objectType}
          objectTypes={objectTypes}
        />
      ) : (
        <GeneralTab
          key={objectType.id}
          spaceId={spaceId}
          objectType={objectType}
          onDeleteOpenChange={setIsDeleteOpen}
        />
      )}
    </>
  );
}
