/* --------------------------------------------------------------------------
   Spinner — Heritage Gold pulsing dot loading indicator.

   Reuses the .streaming-dot CSS animation (llteacher-stream-pulse).
   At larger sizes, increases dot dimensions proportionally.
   -------------------------------------------------------------------------- */

export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps {
  size?: SpinnerSize;
  label?: string;
  className?: string;
}

const SIZE_STYLE: Record<SpinnerSize, React.CSSProperties> = {
  sm: { width: "5px",  height: "5px" },
  md: { width: "7px",  height: "7px" },
  lg: { width: "9px",  height: "9px" },
};

export function Spinner({
  size = "md",
  label = "Loading…",
  className = "",
}: SpinnerProps) {
  return (
    <span
      role="status"
      className={className}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      <span
        aria-hidden="true"
        className="streaming-dot"
        style={SIZE_STYLE[size]}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
