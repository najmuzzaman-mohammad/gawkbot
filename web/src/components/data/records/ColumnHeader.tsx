import { Menu } from "@base-ui/react/menu";
import { MoreHoriz, SortDown, SortUp } from "iconoir-react";

import type { AttributeType, SortDirection } from "../../../api/dataspaces";
import { AttributeTypeIcon } from "../values/attributeTypeIcon";
import type { MoveDirection } from "./columnPrefs";

import "../../../styles/data-records.css";

export interface ColumnHeaderProps {
  label: string;
  /** Omit for system columns such as "Updated". */
  attributeType?: AttributeType;
  /** The direction this column is sorted in right now, if it is the sort. */
  sortedDirection?: SortDirection;
  /** Withhold for columns the store cannot sort (relationship attributes). */
  onSort?: (direction: SortDirection) => void;
  /** Withhold both for pinned columns. */
  onMove?: (direction: MoveDirection) => void;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  onHide?: () => void;
}

/**
 * Column header content: type icon, name, a sort mark when this column is
 * the sort, and a menu button. The menu button is always visible; the
 * actions a column cannot take are withheld rather than shown disabled,
 * except Move, where the end of the row is worth saying out loud.
 */
export function ColumnHeader({
  label,
  attributeType,
  sortedDirection,
  onSort,
  onMove,
  canMoveLeft = false,
  canMoveRight = false,
  onHide,
}: ColumnHeaderProps) {
  const hasMenu = Boolean(onSort || onMove || onHide);
  return (
    <div className="dr-col-head">
      {attributeType ? <AttributeTypeIcon type={attributeType} /> : null}
      <span className="dr-col-head-label" title={label}>
        {label}
      </span>
      {sortedDirection ? (
        <span className="dr-col-head-sort" aria-hidden="true">
          {sortedDirection === "asc" ? <SortUp /> : <SortDown />}
        </span>
      ) : null}
      {hasMenu ? (
        <Menu.Root>
          <Menu.Trigger
            className="dr-icon-button dr-col-head-menu"
            aria-label={`${label} column options`}
          >
            <MoreHoriz aria-hidden="true" focusable="false" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              className="dr-popover-positioner"
              align="start"
              sideOffset={4}
            >
              <Menu.Popup className="dr-menu">
                {onSort ? (
                  <>
                    <Menu.Item
                      className="dr-menu-item"
                      onClick={() => onSort("asc")}
                    >
                      Sort ascending
                    </Menu.Item>
                    <Menu.Item
                      className="dr-menu-item"
                      onClick={() => onSort("desc")}
                    >
                      Sort descending
                    </Menu.Item>
                  </>
                ) : null}
                {onMove ? (
                  <>
                    <Menu.Item
                      className="dr-menu-item"
                      disabled={!canMoveLeft}
                      onClick={() => onMove("left")}
                    >
                      Move left
                    </Menu.Item>
                    <Menu.Item
                      className="dr-menu-item"
                      disabled={!canMoveRight}
                      onClick={() => onMove("right")}
                    >
                      Move right
                    </Menu.Item>
                  </>
                ) : null}
                {onHide ? (
                  <Menu.Item className="dr-menu-item" onClick={onHide}>
                    Hide
                  </Menu.Item>
                ) : null}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : null}
    </div>
  );
}
