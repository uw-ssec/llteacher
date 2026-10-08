import { forwardRef, useId } from "react";

/* --------------------------------------------------------------------------
   Input — labelled form field styled to match the v2 aesthetic.

   Composer styling at smaller scale: soft surface background, no border at
   rest, thin Husky Purple border on focus, 8px radius.

   The label is rendered above in small caps. Error and helper text below.
   -------------------------------------------------------------------------- */

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  label: string;
  type?: "text" | "email" | "password" | "number" | "search" | "url" | "tel";
  helperText?: string;
  error?: string;
  id?: string;
  required?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input(
    {
      label,
      type = "text",
      helperText,
      error,
      id: externalId,
      required,
      className = "",
      ...rest
    },
    ref,
  ) {
    const generatedId = useId();
    const id = externalId ?? generatedId;
    const helperId = `${id}-helper`;
    const errorId = `${id}-error`;
    const hasError = Boolean(error);
    const describedBy = [
      helperText && !hasError ? helperId : null,
      hasError ? errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

    const inputClasses = [
      "input-field",
      hasError ? "input-field--error" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className="input-group">
        {/* Label — mono small-caps */}
        <label
          htmlFor={id}
          className="input-group__label"
        >
          {label}
          {required && (
            <span
              aria-hidden="true"
              className="input-group__required"
              title="Required"
            >
              *
            </span>
          )}
        </label>

        <input
          ref={ref}
          id={id}
          type={type}
          required={required}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          className={inputClasses}
          {...rest}
        />

        {helperText && !hasError && (
          <p
            id={helperId}
            className="input-group__helper"
          >
            {helperText}
          </p>
        )}

        {hasError && (
          <p
            id={errorId}
            role="alert"
            className="input-group__error"
          >
            {error}
          </p>
        )}
      </div>
    );
  },
);
