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

export function Spinner({
  size = "md",
  label = "Loading…",
  className = "",
}: SpinnerProps) {
  return (
    <span
      role="status"
      className={`spinner ${className}`}
    >
      <span
        aria-hidden="true"
        className="streaming-dot"
      >
        <span className={`spinner--${size}`} />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
