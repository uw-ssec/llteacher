import { EditableTitle } from "@llteacher/ui";
import type { ConversationListItemResponse } from "../../shared/types";

/* --------------------------------------------------------------------------
   ConversationListItem — one row in the tutor-conversations rail (#4).

   Renders a wire-shaped ConversationListItemResponse (shared/types.ts);
   lives in apps/web, not packages/ui, since packages/ui has no apps/web
   import anywhere.

   The whole row (including the title text) is clickable/keyboard-
   activatable to select the conversation; renaming lives behind a small
   pencil-icon button (EditableTitle's own rename trigger) nested inside it.
   That makes the row a <div role="button" tabIndex="0">, not a literal
   <button>: a literal <button> cannot contain another literal <button>
   (invalid HTML), and EditableTitle's pencil trigger IS a real nested one --
   the same shape as a Gmail/Linear/GitHub Issues list row with an inline
   icon action.

   Two propagation guards this requires (EditableTitle's own pencil button
   already stopPropagation()s its OWN click, unrelated to these):
     - onKeyDown checks `e.target === e.currentTarget` before treating
       Enter/Space as "select the row" -- keydown bubbles from a focused
       pencil button up through this row, so without the check,
       keyboard-activating the pencil would ALSO fire onSelect.
     - No such check is needed for onClick: the pencil button's own
       stopPropagation already covers both the mouse-click and the
       keyboard-activation-fires-a-real-click-event cases.
   -------------------------------------------------------------------------- */

export interface ConversationListItemProps {
  conversation: ConversationListItemResponse;
  isSelected: boolean;
  onSelect: () => void;
  /** Persists a rename for this row's conversation. Rejects on failure --
   *  see EditableTitle's doc comment for how that's surfaced inline. */
  onRename: (newTitle: string) => Promise<void>;
  /** False hides the rename affordance entirely. Defaults to true: every
   *  conversation GET /api/conversations returns is already scoped to the
   *  caller's own rows (see routes/conversations.ts's listConversationsHandler
   *  doc comment), so every row in this list is the signed-in student's own
   *  conversation -- there is no non-owner case for this particular list
   *  today. The prop exists so a future non-owner-facing surface (e.g. a
   *  teacher viewing a student's conversation) can pass false without any
   *  change here. */
  isEditable?: boolean;
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

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  onRename,
  isEditable = true,
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
      <div
        className={
          isSelected
            ? "tutor-conversation-item tutor-conversation-item--selected"
            : "tutor-conversation-item"
        }
        role="button"
        tabIndex={0}
        aria-current={isSelected ? "true" : undefined}
        aria-label={`Select conversation: ${title}`}
        aria-describedby={metaId}
        onClick={onSelect}
        onKeyDown={(e) => {
          // See this file's doc comment -- without this check, keyboard-
          // activating the nested pencil button would also select the row.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <EditableTitle
          value={title}
          onSave={onRename}
          isEditable={isEditable}
          className="tutor-conversation-item__title"
        />
        <span className="tutor-conversation-item__meta" id={metaId}>
          <span className="tutor-conversation-item__time">{formatUpdatedAt(updatedAt)}</span>
          {/* #233: visible text plus a visually-hidden expansion, not
              aria-label on a plain <span> -- aria-label support on a
              non-interactive element without a naming role isn't
              guaranteed the way it is on this component's own role="button"
              row above. */}
          <span className="tutor-conversation-item__count">
            {messageCount}
            <span className="sr-only"> {messageCount === 1 ? "message" : "messages"}</span>
          </span>
        </span>
      </div>
    </li>
  );
}
