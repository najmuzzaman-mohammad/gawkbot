import {
  type ComponentType,
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useRef,
} from "react";

import { RatingField } from "./RatingField";
import { SelectField } from "./SelectField";
import type { DisplayableAttributeType } from "./ValueCell";
import { useAutoFocus, type ValueFieldProps } from "./valueFieldTypes";
import { TOGGLE_DRAFT_FALSE, TOGGLE_DRAFT_TRUE } from "./valueFormat";

import "../../../styles/data-values.css";

export type { ValueFieldProps } from "./valueFieldTypes";

const DEFAULT_CURRENCY_CODE = "USD";

interface InputEditorConfig {
  type: "text" | "email" | "url" | "tel" | "date";
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  autoComplete?: string;
  isNumeric?: boolean;
}

/**
 * Number and currency use a text input with a decimal keypad, not
 * `type="number"`: a number input reports "" for anything it cannot parse, so
 * a typo would commit as "clear this value" instead of reaching the client
 * and coming back as a readable validation error.
 */
function inputEditor(config: InputEditorConfig) {
  return function InputEditor({
    attribute,
    draft,
    onDraftChange,
    autoFocus,
    disabled,
    id,
  }: ValueFieldProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    useAutoFocus(inputRef, autoFocus);
    const adornment =
      attribute.type === "currency"
        ? attribute.currencyCode?.trim() || DEFAULT_CURRENCY_CODE
        : null;
    return (
      <span className="dv-input-wrap">
        {adornment ? (
          <span className="dv-input__adornment" aria-hidden="true">
            {adornment}
          </span>
        ) : null}
        <input
          ref={inputRef}
          id={id}
          className="dv-input"
          data-numeric={config.isNumeric ? "true" : "false"}
          type={config.type}
          inputMode={config.inputMode}
          autoComplete={config.autoComplete ?? "off"}
          spellCheck={config.type === "text" && !config.isNumeric}
          aria-label={
            id
              ? undefined
              : adornment
                ? `${attribute.name} (${adornment})`
                : attribute.name
          }
          aria-required={attribute.isRequired}
          value={draft}
          disabled={disabled}
          onChange={(event) => onDraftChange(event.target.value)}
        />
      </span>
    );
  };
}

function ToggleEditor({
  attribute,
  draft,
  onDraftChange,
  autoFocus,
  disabled,
  id,
}: ValueFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useAutoFocus(inputRef, autoFocus);
  const isChecked = draft === TOGGLE_DRAFT_TRUE;
  return (
    <label className="dv-checkbox">
      <input
        ref={inputRef}
        id={id}
        className="dv-checkbox__input"
        type="checkbox"
        aria-label={id ? undefined : attribute.name}
        checked={isChecked}
        disabled={disabled}
        onChange={(event) =>
          onDraftChange(
            event.target.checked ? TOGGLE_DRAFT_TRUE : TOGGLE_DRAFT_FALSE,
          )
        }
      />
      <span className="dv-checkbox__label">{isChecked ? "Yes" : "No"}</span>
    </label>
  );
}

const NumericEditor = inputEditor({
  type: "text",
  inputMode: "decimal",
  isNumeric: true,
});

/** One editor per attribute type. Relationships are edited by their picker. */
export const VALUE_FIELD_EDITORS: Record<
  DisplayableAttributeType,
  ComponentType<ValueFieldProps>
> = {
  text: inputEditor({ type: "text", inputMode: "text" }),
  number: NumericEditor,
  currency: NumericEditor,
  date: inputEditor({ type: "date" }),
  toggle: ToggleEditor,
  select: SelectField,
  status: SelectField,
  rating: RatingField,
  url: inputEditor({ type: "url", inputMode: "url" }),
  email: inputEditor({ type: "email", inputMode: "email" }),
  phone: inputEditor({ type: "tel", inputMode: "tel", autoComplete: "off" }),
};

/**
 * The editor for one attribute, on the string-draft contract.
 *
 * Enter commits and Escape cancels for every type; both are handled here once
 * so no editor can forget them. An editor that gives a key its own meaning
 * (the listbox picking on Enter) calls `preventDefault`, and this handler
 * stands down. Focus leaving the field commits, matching a spreadsheet.
 */
export function ValueField(props: ValueFieldProps): ReactNode {
  const { attribute, onCommit, onCancel } = props;
  if (attribute.type === "relationship") return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey && onCommit) {
      event.preventDefault();
      onCommit();
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      // The edit consumed this Escape; a drawer or dialog around the cell
      // must not also close on it.
      event.stopPropagation();
      onCancel();
    }
  };

  const handleBlur = (event: FocusEvent<HTMLFieldSetElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    onCommit?.();
  };

  const Editor = VALUE_FIELD_EDITORS[attribute.type];
  return (
    <fieldset
      className="dv-field"
      data-type={attribute.type}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <Editor {...props} />
    </fieldset>
  );
}
