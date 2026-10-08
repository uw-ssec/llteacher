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
  success: "badge badge--success",
  warning: "badge badge--warning",
  danger:  "badge badge--danger",
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
    `badge--${size}`,
    outlined ? "badge--outlined" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
    >
      {children}
    </span>
  );
}
