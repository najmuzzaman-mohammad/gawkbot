import { Menu } from "@base-ui/react/menu";
import { Link } from "@tanstack/react-router";
import { Plus } from "iconoir-react";

import type { AttributeDefinition } from "../../../api/dataspaces";
import { AttributeTypeIcon } from "../values/attributeTypeIcon";

import "../../../styles/data-records.css";

export interface AddColumnButtonProps {
  spaceId: string;
  typeSlug: string;
  hiddenAttributes: readonly AttributeDefinition[];
  onShow: (slug: string) => void;
}

/**
 * The trailing "+" in the header row: bring a hidden column back, or go
 * define a new attribute in the object type's settings.
 */
export function AddColumnButton({
  spaceId,
  typeSlug,
  hiddenAttributes,
  onShow,
}: AddColumnButtonProps) {
  return (
    <Menu.Root>
      <Menu.Trigger className="dr-icon-button" aria-label="Add column">
        <Plus aria-hidden="true" focusable="false" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="dr-popover-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="dr-menu">
            {hiddenAttributes.length > 0 ? (
              <Menu.Group>
                <Menu.GroupLabel className="dr-menu-label">
                  Hidden columns
                </Menu.GroupLabel>
                {hiddenAttributes.map((attribute) => (
                  <Menu.Item
                    key={attribute.slug}
                    className="dr-menu-item"
                    onClick={() => onShow(attribute.slug)}
                  >
                    <AttributeTypeIcon type={attribute.type} />
                    Show {attribute.name}
                  </Menu.Item>
                ))}
              </Menu.Group>
            ) : (
              <p className="dr-menu-note">Every column is showing.</p>
            )}
            <Menu.Separator className="dr-menu-separator" />
            <Menu.LinkItem
              className="dr-menu-item"
              render={
                <Link
                  to="/data/$spaceId/t/$typeSlug/settings"
                  params={{ spaceId, typeSlug }}
                  search={{ tab: "attributes" }}
                />
              }
            >
              New attribute
            </Menu.LinkItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
