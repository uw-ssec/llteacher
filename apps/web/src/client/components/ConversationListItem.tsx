import { memo } from "react";
import { Trash } from "@phosphor-icons/react";
import { EditableTitle } from "@llteacher/ui";
import type { ConversationListItemResponse } from "../../shared/types";

/* --------------------------------------------------------------------------
   ConversationListItem — one row in the tutor-conversations rail (#4).

   Renders a wire-shaped ConversationListItemResponse (shared/types.ts);
   lives in apps/web, not packages/ui, since packages/ui has no apps/web
   import anywhere.

   #295 redesign (post-review): the outer row is now a plain, non-
   interactive <div> -- NOT role="button". The previous version defended
   role="button" as necessary to contain EditableTitle's real nested pencil
   <button>, reasoning "a literal <button> can't contain a literal
   <button>." True, but ARIA 1.2 defines role="button" as Children
   Presentational: True and normatively prohibits interactive descendants
   too -- a real nested <button> inside a role="button" div is exactly the
   case that rule exists to prevent, and user agents prune that subtree
   (the pencil's role/name were not reliably exposed to assistive tech).
   The row's "select this conversation" affordance now lives on the title
   text itself, rendered as a real sibling <button> by EditableTitle (its
   `onActivateValue` prop, passed below) -- two adjacent buttons (title,
   pencil), no nesting, no ARIA violation. This div is now purely a
   layout/hover grouping for the row, not a target itself.
   -------------------------------------------------------------------------- */

export interface ConversationListItemProps {
  conversation: ConversationListItemResponse;
  isSelected: boolean;
  /** #290: this row's history fetch is in flight. Rendered as selected (so
   *  the click visibly registers immediately) plus `aria-busy`, which is
   *  what tells assistive tech the region is mid-update rather than done. */
  isPending?: boolean;
  /** #310: takes the id rather than closing over it, so the parent can hold
   *  ONE stable handler for the whole list instead of minting a new closure
   *  per row per render -- which is what made React.memo below pointless. */
  onSelect: (id: string) => void;
  /** Persists a rename for this row's conversation. Rejects on failure --
   *  see EditableTitle's doc comment for how that's surfaced inline. */
  onRename: (id: string, newTitle: string) => Promise<void>;
  /** False hides the rename affordance entirely. Defaults to true: every
   *  conversation GET /api/conversations returns is already scoped to the
   *  caller's own rows (see routes/conversations.ts's listConversationsHandler
   *  doc comment), so every row in this list is the signed-in student's own
   *  conversation -- there is no non-owner case for this particular list
   *  today. The prop exists so a future non-owner-facing surface (e.g. a
   *  teacher viewing a student's conversation) can pass false without any
   *  change here. */
  isEditable?: boolean;
  /** #289: when provided, a delete affordance renders beside the rename
   *  pencil. The caller owns confirmation -- this only asks. Omitted
   *  renders nothing, so a non-owner surface stays read-only by default,
   *  matching `isEditable`'s reasoning. */
  onRequestDelete?: (conversation: ConversationListItemResponse) => void;
}

/** "3:45 PM" for today, "Jan 5" otherwise -- short enough for a 240px-ish
 *  rail without wrapping. #228: locale is `undefined` (not a hardcoded
 *  "en-US") so `Intl` resolves the viewer's own runtime default -- a
 *  hardcoded locale showed every student 12-hour "3:45 PM"/"Jan 5"
 *  formatting regardless of their own browser locale. The `options` object
 *  still controls the format (short month, numeric hour); only the locale
 *  argument changed. */
function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ConversationListItemImpl({
  conversation,
  isSelected,
  isPending = false,
  onSelect,
  onRename,
  isEditable = true,
  onRequestDelete,
}: ConversationListItemProps) {
  const { id, title, updatedAt, messageCount } = conversation;
  // #233: the row keeps a short, stable accessible name ("Select
  // conversation: {title}") -- extending it to also read out the time and
  // count inline would still leave the name mismatched against every
  // caller that queries this row's own title text. aria-describedby
  // supplements the name with that metadata instead (most screen readers
  // announce name, then role, then description), which is the fix the
  // finding actually needs: the time and count reach assistive tech
  // without changing what the row is called.
  const metaId = `tutor-conversation-item__meta-${id}`;
  return (
    <li className="tutor-conversation-item-wrap">
      {/* #290: a pending row reads as selected. The click has to produce a
          visible change at once -- selection state used to derive entirely
          from the fetched result, so the whole in-flight window looked
          identical to a dead control, and the natural response (click
          again) just queued a duplicate fetch. */}
      <div
        className={
          [
            "tutor-conversation-item",
            isSelected || isPending ? "tutor-conversation-item--selected" : "",
            isPending ? "tutor-conversation-item--pending" : "",
          ]
            .filter(Boolean)
            .join(" ")
        }
        aria-busy={isPending || undefined}
      >
        {/* #403: title and its action controls share a horizontal row.
            .tutor-conversation-item is flex-direction: column, so a delete
            button placed as its direct child became its own row between the
            title and the metadata -- reserving that height on every
            conversation even while transparent. The rename pencil never had
            this problem because it lives inside EditableTitle; the delete
            control needs the same containment. */}
        <div className="tutor-conversation-item__row">
          <EditableTitle
            value={title}
            onSave={(newTitle) => onRename(id, newTitle)}
            isEditable={isEditable}
            className="tutor-conversation-item__title"
            onActivateValue={() => onSelect(id)}
            activateLabel={`Select conversation: ${title}`}
            activateDescribedBy={metaId}
            isActive={isSelected}
          />
          {/* #289: DELETE /api/conversations/:id shipped ownership-checked,
              404-on-not-owned and FK-safe, and no client code called it --
              from the student's side the rail was append-only. A real
              <button> sibling to the rename pencil, not nested in anything:
              the row is a plain div since #295's redesign precisely so
              adjacent controls stay individually exposed to assistive tech.
              The accessible name carries the title because "Delete" alone is
              indistinguishable between rows in a list. */}
          {onRequestDelete && (
            <button
              type="button"
              className="tutor-conversation-item__delete"
              onClick={() => onRequestDelete(conversation)}
              aria-label={`Delete conversation: ${title}`}
            >
              <Trash size={13} weight="regular" aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="tutor-conversation-item__meta" id={metaId}>
          <span className="tutor-conversation-item__time">{formatUpdatedAt(updatedAt)}</span>
          {/* #233: visible text plus a visually-hidden expansion, not
              aria-label on a plain <span> -- aria-label support on a
              non-interactive element without a naming role isn't
              guaranteed the way it is on the title button above (#295:
              the accessible-name-bearing control here since the redesign
              that removed this row's own role="button"). */}
          <span className="tutor-conversation-item__count">
            {messageCount}
            <span className="sr-only"> {messageCount === 1 ? "message" : "messages"}</span>
          </span>
        </span>
      </div>
    </li>
  );
}

/* #310: the rail re-rendered all 50 rows on every streamed token. #277's
   throttle cut how OFTEN that happened; this cuts what it costs when it
   does. Memo is only worth anything because the callbacks above now take an
   id -- with per-row closures every prop was referentially new on every
   render and this would compare unequal every time. */
export const ConversationListItem = memo(ConversationListItemImpl);
