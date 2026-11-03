import type { ReactNode, SelectHTMLAttributes } from "react";
import { useState } from "react";

import { showNotice } from "../../ui/Toast";

// Reusable settings primitives, styled by styles/settings.css (imported by
// SettingsApp.tsx) the way macOS System Settings lays a page out:
// PageHeader is the title + one-line description; SettingsGroup is an
// inset grouped card with an optional small-caps heading; Field is one
// row of it (label + footnote on the left, control on the right); Select
// is the pop-up button; SaveButton handles the idle/saving/saved state
// machine; KeyField is the password-style input with the "Set" / "Not
// set" badge that every API-key row uses.

interface PageHeaderProps {
  title: string;
  children?: ReactNode;
}

export function PageHeader({ title, children }: PageHeaderProps) {
  return (
    <header className="settings-page-head">
      <h2 className="settings-page-title">{title}</h2>
      {children ? <p className="settings-page-desc">{children}</p> : null}
    </header>
  );
}

interface SettingsGroupProps {
  title?: string;
  /** A sentence or two under the title, above the card. */
  description?: ReactNode;
  /** Rendered beside the title, above the card (e.g. a Recheck button). */
  action?: ReactNode;
  /** Pads the card itself, for content that is not made of rows. */
  padded?: boolean;
  children: ReactNode;
  "data-testid"?: string;
}

export function SettingsGroup({
  title,
  description,
  action,
  padded,
  children,
  "data-testid": testId,
}: SettingsGroupProps) {
  const cardClass = padded
    ? "settings-group-card settings-group-card--padded"
    : "settings-group-card";
  return (
    <section className="settings-group" data-testid={testId}>
      {title && action ? (
        <div className="settings-group-head">
          <div className="settings-group-title">{title}</div>
          {action}
        </div>
      ) : title ? (
        <div className="settings-group-title">{title}</div>
      ) : null}
      {description ? (
        <p className="settings-group-desc">{description}</p>
      ) : null}
      <div className={cardClass}>{children}</div>
    </section>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  /** Label on top, control full-width beneath (textareas, embedded panels). */
  stacked?: boolean;
  children: ReactNode;
}

export function Field({ label, hint, stacked, children }: FieldProps) {
  return (
    <div
      className={
        stacked ? "settings-row settings-row--stacked" : "settings-row"
      }
    >
      <div className="settings-row-main">
        <div className="settings-row-label">{label}</div>
        {hint ? <div className="settings-row-hint">{hint}</div> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

// Select is a native <select> dressed as a macOS pop-up button: the
// browser chrome is hidden and the trailing up/down chevron glyph is an
// inline svg on an accent tile (see .settings-select in settings.css).
export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const selectClass = className
    ? `settings-input ${className}`
    : "settings-input";
  return (
    <span className="settings-select">
      <select className={selectClass} {...rest}>
        {children}
      </select>
      <svg
        className="settings-select-chevron"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M4.5 6.25 8 2.75l3.5 3.5M4.5 9.75 8 13.25l3.5-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

interface SaveButtonProps {
  label: string;
  /** Return `false` to stay idle (nothing saved); anything else, including
   *  a resolved Promise, counts as saved. */
  onSave: () => unknown;
}

export function SaveButton({ label, onSave }: SaveButtonProps) {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");

  const handle = async () => {
    if (state === "saving") return;
    setState("saving");
    try {
      const result = await onSave();
      if (result === false) {
        setState("idle");
        return;
      }
      setState("saved");
      setTimeout(() => setState("idle"), 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showNotice(`Save failed: ${msg}`, "error");
      setState("idle");
    }
  };

  return (
    <div className="settings-save-row">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={handle}
        disabled={state === "saving"}
      >
        {state === "saving" ? "Saving..." : state === "saved" ? "Saved" : label}
      </button>
    </div>
  );
}

interface KeyFieldProps {
  hasValue: boolean;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}

export function KeyField({
  hasValue,
  placeholder,
  value,
  onChange,
}: KeyFieldProps) {
  return (
    <div className="settings-key-field">
      <input
        type="password"
        className="settings-input settings-input--mono"
        placeholder={hasValue ? "•••••••• (set)" : placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span
        className={
          hasValue ? "settings-chip settings-chip--green" : "settings-chip"
        }
      >
        {hasValue ? "Set" : "Not set"}
      </span>
    </div>
  );
}
