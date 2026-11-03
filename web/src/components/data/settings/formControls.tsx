import { type InputHTMLAttributes, type ReactNode, useId } from "react";

import "../../../styles/data-schema.css";

interface FormFieldProps {
  label: string;
  /** One line under the control. */
  hint?: ReactNode;
  isRequired?: boolean;
  /** Receives the id to put on the control so the label points at it. */
  children: (ids: {
    controlId: string;
    hintId: string | undefined;
  }) => ReactNode;
}

/** Label above, control, optional hint below. Plain semantic form markup. */
export function FormField({
  label,
  hint,
  isRequired = false,
  children,
}: FormFieldProps) {
  const controlId = useId();
  const hintId = useId();
  return (
    <div className="data-form-field">
      <label className="data-form-label" htmlFor={controlId}>
        {label}
        {isRequired ? (
          <span className="data-form-required"> (required)</span>
        ) : null}
      </label>
      {children({ controlId, hintId: hint ? hintId : undefined })}
      {hint ? (
        <p className="data-form-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  isRequired?: boolean;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  isRequired = false,
  ...inputProps
}: TextFieldProps) {
  return (
    <FormField label={label} hint={hint} isRequired={isRequired}>
      {({ controlId, hintId }) => (
        <input
          {...inputProps}
          id={controlId}
          className="data-form-input"
          type="text"
          value={value}
          required={isRequired}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  disabled,
  placeholder,
}: TextAreaFieldProps) {
  return (
    <FormField label={label} hint={hint}>
      {({ controlId, hintId }) => (
        <textarea
          id={controlId}
          className="data-form-input data-form-textarea"
          rows={2}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

interface CheckFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
}

/** A native checkbox with its label and hint on one block. */
export function CheckField({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
}: CheckFieldProps) {
  const controlId = useId();
  const hintId = useId();
  return (
    <div className="data-form-check">
      <input
        id={controlId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <div className="data-form-check-text">
        <label htmlFor={controlId}>{label}</label>
        {hint ? (
          <p className="data-form-hint" id={hintId}>
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

interface ReadOnlyValueProps {
  label: string;
  value: string;
  hint?: ReactNode;
  /** Identifiers render in mono; plain words do not. */
  isMono?: boolean;
  action?: ReactNode;
}

/** A value the operator can read but not change, e.g. a slug. */
export function ReadOnlyValue({
  label,
  value,
  hint,
  isMono = false,
  action,
}: ReadOnlyValueProps) {
  return (
    <div className="data-form-field">
      <span className="data-form-label">{label}</span>
      <div className="data-form-readonly">
        <span className={isMono ? "data-mono" : undefined}>{value}</span>
        {action}
      </div>
      {hint ? <p className="data-form-hint">{hint}</p> : null}
    </div>
  );
}

interface FormErrorProps {
  message: string | null;
}

export function FormError({ message }: FormErrorProps) {
  if (message === null) return null;
  return (
    <p className="data-form-error" role="alert">
      {message}
    </p>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
