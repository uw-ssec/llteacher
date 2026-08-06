/* --------------------------------------------------------------------------
   StatusBadge — mono small-caps badge for record state.

   Used across the admin to telegraph status: homework lifecycle, config
   active/default flags, submission progress. Always renders in mono so
   it visually pairs with the RecordId catalog badges.
   -------------------------------------------------------------------------- */

export type StatusKind =
  | "active"
  | "draft"
  | "scheduled"
  | "archived"
  | "past_due"
  | "hidden"
  | "default"
  | "inactive"
  | "submitted"
  | "in_progress"
  | "missing"
  | "no_interaction"
  | "partial";

export type StatusBadgeProps = {
  kind: StatusKind;
  children: React.ReactNode;
};

export function StatusBadge({ kind, children }: StatusBadgeProps) {
  return (
    <span className={`admin-status admin-status--${kind}`}>
      <span className="admin-status__dot" aria-hidden="true" />
      <span className="admin-status__text">{children}</span>
    </span>
  );
}
