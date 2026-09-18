import { Menu } from "@base-ui/react/menu";
import { MoreHoriz } from "iconoir-react";

import type { AttributeDefinition } from "../../../api/dataspaces";

import "../../../styles/data-schema.css";

export const PRIMARY_DELETE_REASON =
  "Every record is named by its primary attribute, so it cannot be deleted.";

interface AttributeRowMenuProps {
  attribute: AttributeDefinition;
  onEdit: () => void;
  onCopyId: () => void;
  onDelete: () => void;
}

/**
 * Row actions for one attribute. Delete stays in the menu for the primary
 * attribute but is disabled, with the reason written under it rather than
 * left to a tooltip.
 */
export function AttributeRowMenu({
  attribute,
  onEdit,
  onCopyId,
  onDelete,
}: AttributeRowMenuProps) {
  const isDeleteBlocked = attribute.isPrimary;
  return (
    <Menu.Root>
      <Menu.Trigger
        className="data-row-menu-trigger"
        aria-label={`Actions for ${attribute.name}`}
      >
        <MoreHoriz aria-hidden="true" width={16} height={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="data-row-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="data-row-menu">
            <Menu.Item className="data-row-menu-item" onClick={onEdit}>
              Edit
            </Menu.Item>
            <Menu.Item className="data-row-menu-item" onClick={onCopyId}>
              Copy id
            </Menu.Item>
            <Menu.Item
              className="data-row-menu-item data-row-menu-item--danger"
              disabled={isDeleteBlocked}
              title={isDeleteBlocked ? PRIMARY_DELETE_REASON : undefined}
              onClick={onDelete}
            >
              <span>Delete</span>
              {isDeleteBlocked ? (
                <span className="data-row-menu-reason">
                  {PRIMARY_DELETE_REASON}
                </span>
              ) : null}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
