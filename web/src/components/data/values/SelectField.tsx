import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Check } from "iconoir-react";

import type { SelectOption } from "../../../api/dataspaces";
import { OptionPill } from "./OptionPill";
import { useAutoFocus, type ValueFieldProps } from "./valueFieldTypes";
import { joinDraftOptionIds, parseDraftOptionIds } from "./valueFormat";

/** `option: null` is the "No value" row that clears a single select. */
interface ListItem {
  id: string;
  option: SelectOption | null;
}

const CLEAR_ITEM: ListItem = { id: "", option: null };
const CLEAR_ITEM_KEY = "__clear";

function buildItems(
  options: readonly SelectOption[],
  query: string,
  canClear: boolean,
): readonly ListItem[] {
  const needle = query.trim().toLowerCase();
  const matches = options
    .filter((option) => option.name.toLowerCase().includes(needle))
    .map((option) => ({ id: option.id, option }));
  return canClear && needle === "" ? [CLEAR_ITEM, ...matches] : matches;
}

function toggleId(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id)
    ? ids.filter((existing) => existing !== id)
    : [...ids, id];
}

function keepInputFocus(event: MouseEvent) {
  // The input owns focus for the whole edit. Letting a click move it to the
  // list would blur the field, and blur commits.
  event.preventDefault();
}

/**
 * Select and status editor: a combobox input that filters a listbox of
 * option pills. Focus never leaves the input; the list is driven through
 * `aria-activedescendant`, which is what lets "blur commits" stay a single
 * containment check in `ValueField`.
 *
 * Single: Enter or click picks the active option and commits.
 * Multivalue: click or Space toggles and keeps the list open. Enter toggles
 * the active option while a filter is typed (then clears the filter), and
 * commits once the filter is empty. Blur commits. Backspace on an empty
 * filter removes the last selection.
 */
export function SelectField({
  attribute,
  draft,
  onDraftChange,
  onCommit,
  onCancel,
  autoFocus,
  disabled,
  id,
}: ValueFieldProps) {
  const isMulti = attribute.isMultivalue;
  const variant = attribute.type === "status" ? "status" : "select";
  const draftIds = parseDraftOptionIds(draft);
  const selectedIds = isMulti ? draftIds : draftIds.slice(0, 1);

  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useAutoFocus(inputRef, autoFocus);

  const canClear = !(isMulti || attribute.isRequired);
  const items = buildItems(attribute.options, query, canClear);
  const clampedIndex = Math.max(0, Math.min(activeIndex, items.length - 1));
  const activeItem = isOpen ? items[clampedIndex] : undefined;
  const optionDomId = (index: number) => `${listId}-option-${index}`;
  const activeDomId = activeItem ? optionDomId(clampedIndex) : undefined;

  useEffect(() => {
    if (!activeDomId) return;
    const active = document.getElementById(activeDomId);
    // Cells never animate, and `nearest` avoids scrolling the page itself.
    if (typeof active?.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [activeDomId]);

  const open = () => {
    if (disabled || isOpen) return;
    const selectedIndex = items.findIndex(
      (item) => item.option !== null && selectedIds.includes(item.id),
    );
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  };

  const pick = (item: ListItem) => {
    if (disabled) return;
    setQuery("");
    if (isMulti) {
      onDraftChange(joinDraftOptionIds(toggleId(selectedIds, item.id)));
      return;
    }
    onDraftChange(item.id);
    setIsOpen(false);
    onCommit?.();
  };

  const moveActive = (delta: number) => {
    if (!isOpen) {
      open();
      return;
    }
    if (items.length === 0) return;
    setActiveIndex((clampedIndex + delta + items.length) % items.length);
  };

  const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setActiveIndex(0);
    setIsOpen(true);
  };

  const pickOnEnter = (): boolean => {
    // Multivalue with no filter typed: Enter means "save", so let it rise.
    if (!activeItem || (isMulti && query === "")) return false;
    pick(activeItem);
    return true;
  };

  const toggleOnSpace = (): boolean => {
    // Once a filter is typed, Space is a character in it.
    if (!(isMulti && activeItem) || query !== "") return false;
    pick(activeItem);
    return true;
  };

  const removeLastSelection = (): boolean => {
    if (query !== "" || selectedIds.length === 0) return false;
    onDraftChange(joinDraftOptionIds(selectedIds.slice(0, -1)));
    return true;
  };

  /**
   * True when the key was consumed. A consumed key is `preventDefault`ed,
   * which is also the signal `ValueField` reads to stand down its own Enter
   * and Escape handling.
   */
  const consumeKey = (key: string): boolean => {
    switch (key) {
      case "ArrowDown":
        moveActive(1);
        return true;
      case "ArrowUp":
        moveActive(-1);
        return true;
      case "Enter":
        return pickOnEnter();
      case " ":
        return toggleOnSpace();
      case "Backspace":
        return removeLastSelection();
      default:
        return false;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // Inside a plain form there is nothing to cancel, so Escape only closes
      // the list and must not reach (and close) the dialog around it. With a
      // cancel handler, Escape rises to ValueField and cancels the edit.
      if (!isOpen || onCancel) return;
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      return;
    }
    if (consumeKey(event.key)) event.preventDefault();
  };

  const chosenOptions = selectedIds.flatMap((selectedId) => {
    const option = attribute.options.find(
      (candidate) => candidate.id === selectedId,
    );
    return option ? [option] : [];
  });

  return (
    <div className="dv-select" data-open={isOpen ? "true" : "false"}>
      {/* A label, so a click anywhere in the control focuses the input
          natively, with no click handler on a static element. */}
      <label
        className="dv-select__control"
        data-disabled={disabled ? "true" : "false"}
      >
        {chosenOptions.map((option) => (
          <OptionPill key={option.id} option={option} variant={variant} />
        ))}
        <input
          ref={inputRef}
          id={id}
          className="dv-select__input"
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-label={attribute.name}
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeDomId}
          placeholder={chosenOptions.length === 0 ? "Find an option" : ""}
          value={query}
          disabled={disabled}
          onChange={handleQueryChange}
          onKeyDown={handleKeyDown}
          onFocus={open}
          onClick={open}
          onBlur={() => setIsOpen(false)}
        />
      </label>
      <div
        id={listId}
        className="dv-listbox"
        role="listbox"
        aria-label={`${attribute.name} options`}
        aria-multiselectable={isMulti}
        hidden={!isOpen}
      >
        {items.map((item, index) => {
          const isSelected =
            item.option !== null && selectedIds.includes(item.id);
          return (
            <button
              key={item.id === "" ? CLEAR_ITEM_KEY : item.id}
              id={optionDomId(index)}
              type="button"
              className="dv-listbox__option"
              role="option"
              tabIndex={-1}
              aria-selected={isSelected}
              data-active={index === clampedIndex ? "true" : "false"}
              disabled={disabled}
              onMouseDown={keepInputFocus}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => pick(item)}
            >
              <span className="dv-listbox__check" aria-hidden="true">
                {isSelected ? <Check focusable="false" /> : null}
              </span>
              {item.option ? (
                <OptionPill option={item.option} variant={variant} />
              ) : (
                <span className="dv-listbox__clear">No value</span>
              )}
            </button>
          );
        })}
        {items.length === 0 ? (
          <div className="dv-listbox__empty">
            {attribute.options.length === 0
              ? "No options yet"
              : "No matching options"}
          </div>
        ) : null}
        {isMulti && items.length > 0 ? (
          <div className="dv-listbox__hint">Space toggles. Enter saves.</div>
        ) : null}
      </div>
    </div>
  );
}
