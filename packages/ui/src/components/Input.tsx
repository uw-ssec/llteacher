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
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        {/* Label — mono small-caps */}
        <label
          htmlFor={id}
          style={{
            display: "block",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-xs)",
            fontVariant: "small-caps",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--color-text-secondary)",
            marginBlockEnd: "var(--space-1)",
          }}
        >
          {label}
          {required && (
            <span
              aria-hidden="true"
              style={{ marginInlineStart: "0.2em", color: "var(--color-error)" }}
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
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-muted)",
              margin: 0,
            }}
          >
            {helperText}
          </p>
        )}

        {hasError && (
          <p
            id={errorId}
            role="alert"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-error)",
              margin: 0,
            }}
          >
            {error}
          </p>
        )}
      </div>
    );
  },
);
