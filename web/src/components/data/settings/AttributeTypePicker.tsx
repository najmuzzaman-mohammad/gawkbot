import { ATTRIBUTE_TYPES, type AttributeType } from "../../../api/dataspaces";
import { AttributeTypeIcon } from "../values/attributeTypeIcon";
import { attributeTypeLabel } from "../values/valueFormat";
import { ATTRIBUTE_TYPE_HINTS } from "./attributeDraft";

import "../../../styles/data-schema.css";

interface AttributeTypePickerProps {
  onPick: (type: AttributeType) => void;
}

/**
 * Step one of a new attribute: the twelve types, each with its icon, label,
 * and a one-line hint. The type is fixed once the attribute exists, so the
 * choice comes first and on its own.
 */
export function AttributeTypePicker({ onPick }: AttributeTypePickerProps) {
  return (
    <ul className="data-type-picker" aria-label="Attribute types">
      {ATTRIBUTE_TYPES.map((type) => (
        <li key={type}>
          <button
            type="button"
            className="data-type-picker-option"
            onClick={() => onPick(type)}
          >
            <AttributeTypeIcon type={type} />
            <span className="data-type-picker-text">
              <span className="data-type-picker-label">
                {attributeTypeLabel(type)}
              </span>
              <span className="data-type-picker-hint">
                {ATTRIBUTE_TYPE_HINTS[type]}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
