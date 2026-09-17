import { ArrowDown, ArrowUp, Plus, Xmark } from "iconoir-react";

import { Button } from "../DataButton";
import { type DraftOption, mintOptionKey, moveOption } from "./attributeDraft";

import "../../../styles/data-schema.css";

interface OptionsEditorProps {
  options: readonly DraftOption[];
  onChange: (options: readonly DraftOption[]) => void;
  /** Shown under the list, e.g. the status default. */
  hint?: string;
  disabled?: boolean;
}

/**
 * Option names for a new select or status attribute. Order is the order the
 * options appear in pickers, so rows move with explicit up and down buttons
 * (keyboard reachable, no drag needed).
 */
export function OptionsEditor({
  options,
  onChange,
  hint,
  disabled = false,
}: OptionsEditorProps) {
  function rename(key: string, name: string) {
    onChange(
      options.map((option) =>
        option.key === key ? { ...option, name } : option,
      ),
    );
  }

  return (
    <fieldset className="data-options-editor" disabled={disabled}>
      <legend className="data-form-label">Options</legend>
      {options.length > 0 ? (
        <ol className="data-options-list">
          {options.map((option, index) => {
            const position = index + 1;
            const label = option.name.trim() || `option ${position}`;
            return (
              <li key={option.key} className="data-options-row">
                <input
                  className="data-form-input"
                  type="text"
                  value={option.name}
                  aria-label={`Option ${position}`}
                  placeholder={`Option ${position}`}
                  autoComplete="off"
                  onChange={(event) => rename(option.key, event.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={index === 0}
                  aria-label={`Move ${label} up`}
                  onClick={() => onChange(moveOption(options, index, -1))}
                >
                  <ArrowUp aria-hidden="true" width={16} height={16} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={index === options.length - 1}
                  aria-label={`Move ${label} down`}
                  onClick={() => onChange(moveOption(options, index, 1))}
                >
                  <ArrowDown aria-hidden="true" width={16} height={16} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${label}`}
                  onClick={() =>
                    onChange(options.filter((item) => item.key !== option.key))
                  }
                >
                  <Xmark aria-hidden="true" width={16} height={16} />
                </Button>
              </li>
            );
          })}
        </ol>
      ) : null}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([...options, { key: mintOptionKey(), name: "" }])
          }
        >
          <Plus aria-hidden="true" width={14} height={14} />
          Add option
        </Button>
      </div>
      {hint ? <p className="data-form-hint">{hint}</p> : null}
    </fieldset>
  );
}
