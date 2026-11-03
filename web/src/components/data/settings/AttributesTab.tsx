import { useId, useState } from "react";

import type { AttributeDefinition, ObjectType } from "../../../api/dataspaces";
import { showNotice } from "../../ui/Toast";
import { BotByline } from "../BotByline";
import { Button } from "../DataButton";
import { DeletePreviewDialog } from "../DeletePreviewDialog";
import { AttributeTypeIcon } from "../values/attributeTypeIcon";
import { attributeTypeLabel } from "../values/valueFormat";
import { AttributeProperties } from "./AttributeProperties";
import { AttributeRowMenu } from "./AttributeRowMenu";
import { CreateAttributeDialog } from "./CreateAttributeDialog";
import { copyText } from "./copyText";
import { EditAttributeDialog } from "./EditAttributeDialog";

import "../../../styles/data-schema.css";

interface AttributesTabProps {
  spaceId: string;
  objectType: ObjectType;
  /** Every type in the space, for relationship targets. */
  objectTypes: readonly ObjectType[];
}

interface DeleteTarget {
  id: string;
  name: string;
}

function matchesSearch(attribute: AttributeDefinition, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    attribute.name.toLowerCase().includes(needle) ||
    attribute.slug.toLowerCase().includes(needle) ||
    attributeTypeLabel(attribute.type).toLowerCase().includes(needle)
  );
}

/**
 * Attributes of one object type: search, the table, and the create, edit,
 * and delete dialogs. Deleting goes through the two-phase preview, so the
 * operator sees how many values go with the attribute first.
 */
export function AttributesTab({
  spaceId,
  objectType,
  objectTypes,
}: AttributesTabProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Held by value: the refetch after a delete removes the attribute from the
  // schema before the dialog reports back.
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);

  const visible = objectType.attributes.filter((attribute) =>
    matchesSearch(attribute, query),
  );
  // Looked up by id, so the dialogs always see the refetched definition.
  const editing =
    objectType.attributes.find((item) => item.id === editingId) ?? null;

  return (
    <section className="data-settings-panel" aria-label="Attributes">
      <div className="data-toolbar">
        <div className="data-toolbar-search">
          <label className="data-visually-hidden" htmlFor={searchId}>
            Search attributes
          </label>
          <input
            id={searchId}
            className="data-form-input"
            type="search"
            placeholder="Search attributes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button onClick={() => setIsCreateOpen(true)}>New attribute</Button>
      </div>
      <div className="data-list-scroll">
        <table className="data-list-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Properties</th>
              <th scope="col">Slug</th>
              <th scope="col">Created by</th>
              <th scope="col">
                <span className="data-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((attribute) => (
              <tr
                key={attribute.id}
                data-testid={`attribute-row-${attribute.slug}`}
              >
                <th scope="row" className="data-list-name">
                  <span className="data-list-link--icon">
                    <AttributeTypeIcon type={attribute.type} />
                    {attribute.name}
                  </span>
                </th>
                <td className="data-list-nowrap">
                  {attributeTypeLabel(attribute.type)}
                </td>
                <td>
                  <AttributeProperties
                    attribute={attribute}
                    objectTypes={objectTypes}
                  />
                </td>
                <td>
                  <span className="data-mono">{attribute.slug}</span>
                </td>
                <td>
                  <BotByline actor={attribute.createdBy} />
                </td>
                <td className="data-list-actions">
                  <AttributeRowMenu
                    attribute={attribute}
                    onEdit={() => setEditingId(attribute.id)}
                    onCopyId={() => {
                      void copyText(attribute.id, "Attribute id");
                    }}
                    onDelete={() =>
                      setDeleting({ id: attribute.id, name: attribute.name })
                    }
                  />
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="data-list-empty">
                  No attribute matches "{query.trim()}". Search looks at the
                  name, the slug, and the type.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <CreateAttributeDialog
        spaceId={spaceId}
        objectType={objectType}
        objectTypes={objectTypes}
        open={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
      />
      {editing ? (
        <EditAttributeDialog
          key={editing.id}
          spaceId={spaceId}
          typeId={objectType.id}
          attribute={editing}
          onClose={() => setEditingId(null)}
        />
      ) : null}
      <DeletePreviewDialog
        spaceId={spaceId}
        kind="attribute"
        ids={deleting ? [deleting.id] : []}
        subjectLabel={
          deleting ? `the ${deleting.name} attribute` : "this attribute"
        }
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          if (deleting) showNotice(`Deleted ${deleting.name}.`, "success");
        }}
      />
    </section>
  );
}
