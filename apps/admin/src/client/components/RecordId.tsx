/* --------------------------------------------------------------------------
   RecordId — the signature element of the admin console.

   Every cataloged artifact (homework, LLM config, student, etc.) renders
   with a small Heritage Gold mono badge: `HW·003`, `CFG·001`. The midline
   dot (· U+00B7) separates the prefix from the zero-padded index. Reads
   as "we are in a catalog of typed records" — not a SaaS dashboard.

   The prefix encodes the record type; keep the prefix space short (2-4
   chars). The index is zero-padded to 3 digits for consistent width.
   -------------------------------------------------------------------------- */

export type RecordIdProps = {
  prefix: "HW" | "CFG" | "STU" | "SEC";
  index: number;
  /** Visual size; defaults to "md" */
  size?: "sm" | "md";
};

export function RecordId({ prefix, index, size = "md" }: RecordIdProps) {
  const padded = String(index).padStart(3, "0");
  return (
    <span
      className={size === "sm" ? "admin-record-id admin-record-id--sm" : "admin-record-id"}
      aria-label={`Record ${prefix}-${padded}`}
    >
      <span className="admin-record-id__prefix">{prefix}</span>
      <span className="admin-record-id__sep" aria-hidden="true">·</span>
      <span className="admin-record-id__index">{padded}</span>
    </span>
  );
}
