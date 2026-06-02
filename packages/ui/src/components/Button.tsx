import { forwardRef } from "react";

/* --------------------------------------------------------------------------
   Button — text-link or minimal outlined action affordance.

   In the v2 aesthetic, buttons are never vivid filled pills. They are:
   - Text-links (default) — inherit body text, hover darkens
   - Accent variant — Husky Purple, for primary actions (e.g., ▸ Submit)
   - Danger variant — error color, for destructive actions
   - Outlined variant — thin border, no fill

   The `leadingIcon` prop is used for marker prefixes (▸, ◇, etc.).
   Loading state renders a rotating * inline rather than a spinner.
   -------------------------------------------------------------------------- */

export type ButtonVariant = "default" | "accent" | "danger" |
  /* Legacy names — mapped internally for backward compatibility */
  "primary" | "secondary" | "ghost";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  outlined?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  children: React.ReactNode;
}

/* Normalize legacy variant names */
function resolveVariant(v: ButtonVariant): "default" | "accent" | "danger" {
  if (v === "primary" || v === "accent") return "accent";
  if (v === "danger") return "danger";
  return "default";
}

const SIZE_FONT: Record<ButtonSize, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "default",
      size = "md",
      loading = false,
      outlined = false,
      leadingIcon,
      trailingIcon,
      disabled,
      children,
      className = "",
      ...rest
    },
    ref,
  ) {
    const resolved = resolveVariant(variant);
    const isDisabled = disabled || loading;

    const classes = [
      "btn",
      resolved === "accent" ? "btn--accent" : "",
      resolved === "danger" ? "btn--danger" : "",
      outlined ? "btn--outlined" : "",
      SIZE_FONT[size],
      isDisabled ? "opacity-40 pointer-events-none" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={classes}
        {...rest}
      >
        {loading ? (
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              animation: "llteacher-spin 1s linear infinite",
              marginInlineEnd: "0.3em",
            }}
          >
            *
          </span>
        ) : leadingIcon ? (
          <span aria-hidden="true" style={{ marginInlineEnd: "0.25em" }}>
            {leadingIcon}
          </span>
        ) : null}

        <span>{children}</span>

        {!loading && trailingIcon ? (
          <span aria-hidden="true" style={{ marginInlineStart: "0.25em" }}>
            {trailingIcon}
          </span>
        ) : null}
      </button>
    );
  },
);
