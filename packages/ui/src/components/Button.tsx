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
  /** #317 review, #327: `aria-disabled` instead of native `disabled` --
   *  keeps the button focusable and in the accessibility tree while
   *  suppressing activation (click and keyboard), instead of native
   *  `disabled` dropping it from the tab order the instant it's set --
   *  mid-click, if the button currently has focus, that strands a
   *  keyboard user at `document.body` with nothing to restore it
   *  (Composer.tsx's #270 fix, generalized to every button). Use this for
   *  a button that's disabled only transiently, mid-interaction (a
   *  submit that's in flight, a dialog action while its sibling
   *  request runs) -- not for a button with genuinely nothing to
   *  preserve focus for, which should keep using plain `disabled`. */
  ariaDisabled?: boolean;
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
      ariaDisabled = false,
      children,
      className = "",
      onClick,
      ...rest
    },
    ref,
  ) {
    const resolved = resolveVariant(variant);
    // #317 review, #327: `loading` used to fold into native `disabled` too
    // (isDisabled = disabled || loading) -- exactly the AlertDialog Confirm
    // button's own bug (its own doc comment on `confirming`/`loading`):
    // paired with Cancel's explicit `disabled={confirming}`, a confirming
    // dialog had ZERO focusable descendants, so "Confirming…" was
    // announced nowhere. `loading` now behaves like `ariaDisabled` --
    // focusable, activation suppressed, `aria-busy` still set for the
    // spinner -- unless the caller ALSO passed the plain `disabled` prop,
    // which stays a hard, native disable.
    const isDisabled = !!disabled;
    const isAriaDisabled = !isDisabled && (ariaDisabled || loading);

    const classes = [
      "btn",
      resolved === "accent" ? "btn--accent" : "",
      resolved === "danger" ? "btn--danger" : "",
      outlined ? "btn--outlined" : "",
      SIZE_FONT[size],
      isDisabled || isAriaDisabled ? "opacity-40" : "",
      isDisabled ? "pointer-events-none" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    // #327: suppresses BOTH mouse and keyboard (Enter/Space) activation --
    // pointer-events:none above already blocks mouse hit-testing on a
    // native `disabled` button, but has no effect on a keyboard-triggered
    // click on a focusable, aria-disabled one, so the guard has to live
    // here, not just in CSS.
    const handleClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
      if (isAriaDisabled) {
        e.preventDefault();
        return;
      }
      onClick?.(e);
    };

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        aria-disabled={isAriaDisabled || undefined}
        aria-busy={loading || undefined}
        className={classes}
        onClick={handleClick}
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
