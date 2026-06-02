/* --------------------------------------------------------------------------
   Badge — tiny small-caps mono label.

   In the v2 aesthetic, badges are never pills with vivid fills.
   They are inline typographic labels: mono small-caps, optionally outlined
   with a thin 1px border. No rounded corners beyond 2px.

   Variant:
     neutral  — muted text, no border
     accent   — Husky Purple text, no border
     outlined — muted text + thin border
   -------------------------------------------------------------------------- */

export type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger";
export type BadgeSize    = "sm" | "md";

export interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  outlined?: boolean;
  children: React.ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "badge",
  accent:  "badge badge--accent",
  success: "badge",
  warning: "badge",
  danger:  "badge",
};

const VARIANT_STYLE: Record<BadgeVariant, React.CSSProperties> = {
  neutral: {},
  accent:  {},
  success: { color: "var(--color-success)" },
  warning: { color: "var(--color-warning)" },
  danger:  { color: "var(--color-error)" },
};

const SIZE_STYLE: Record<BadgeSize, React.CSSProperties> = {
  sm: { fontSize: "0.6875rem" },
  md: { fontSize: "var(--font-size-xs)" },
};

export function Badge({
  variant = "neutral",
  size = "md",
  outlined = false,
  children,
  className = "",
}: BadgeProps) {
  const classes = [
    VARIANT_CLASSES[variant],
    outlined ? "badge--outlined" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      style={{ ...SIZE_STYLE[size], ...VARIANT_STYLE[variant] }}
    >
      {children}
    </span>
  );
}
