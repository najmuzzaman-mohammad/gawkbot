import { useId } from "react";

import {
  OBJECT_TYPE_ICON_KEYS,
  objectTypeIcon,
} from "../values/attributeTypeIcon";

import "../../../styles/data-schema.css";

interface IconPickerProps {
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
}

function iconLabel(key: string): string {
  return key.replace(/-/g, " ");
}

/**
 * Icon choice for an object type. Native radio inputs give the group its
 * semantics and arrow-key behavior for free; the inputs are visually hidden
 * and the label draws the tile.
 */
export function IconPicker({
  value,
  onChange,
  disabled = false,
}: IconPickerProps) {
  const groupName = useId();
  return (
    <fieldset className="data-icon-picker" disabled={disabled}>
      <legend className="data-form-label">Icon</legend>
      <div className="data-icon-picker-grid">
        {OBJECT_TYPE_ICON_KEYS.map((key) => {
          const Icon = objectTypeIcon(key);
          return (
            <label
              key={key}
              className="data-icon-option"
              title={iconLabel(key)}
            >
              <input
                type="radio"
                name={groupName}
                value={key}
                checked={value === key}
                aria-label={iconLabel(key)}
                onChange={() => onChange(key)}
              />
              <span className="data-icon-option-tile">
                <Icon aria-hidden="true" focusable="false" />
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
