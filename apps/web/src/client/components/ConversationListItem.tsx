import { EditableTitle } from "@llteacher/ui";
import type { ConversationListItemResponse } from "../../shared/types";

/* --------------------------------------------------------------------------
   ConversationListItem — one row in the tutor-conversations rail (#4).

   Echoes @llteacher/ui's SectionItem rhythm (indicator · text · meta) but
   lives in apps/web, not packages/ui: it renders a wire-shaped
   ConversationListItemResponse (apps/web/src/shared/types.ts), which
   packages/ui's other components deliberately don't depend on (the design
   system package has no apps/web import anywhere, matching apps/admin's
   own "apps/admin never imports from apps/web" convention noted in
   SubmissionsView.tsx).

   #6 (redesigned post-review): #4's original contract is restored -- the
   whole row (including the title text) is clickable/keyboard-activatable
   to select the conversation, exactly like before this task touched it.
   Renaming now lives behind a small pencil-icon button (EditableTitle's
   own rename trigger, see that component's doc comment) nested inside the
   row.

   This makes the row a <div role="button" tabIndex="0">, not a literal
   <button>: a literal <button> cannot contain another literal <button>
   (invalid HTML -- the browser would silently close the outer one early
   the moment it hit the nested one), and EditableTitle's pencil trigger
   IS a real nested <button>. A clickable row containing a smaller nested
   action button is a well-established, widely-shipped pattern (the same
   shape as a Gmail/Linear/GitHub Issues list row with an inline icon
   action) even though it sits outside the strictest ARIA "don't nest
   interactive controls" guidance -- accepted here deliberately rather than
   duplicating EditableTitle's entire trigger+input+error state outside
   the component just to keep the outer element a literal <button>.

   Two propagation guards this requires, both in this file (EditableTitle's
   own pencil button already stopPropagation()s its OWN click, unrelated to
   these):
     - onKeyDown checks `e.target === e.currentTarget` before treating
       Enter/Space as "select the row" -- keydown bubbles from a focused
       pencil button up through this row, so without the check, keyboard-
       activating the pencil (Enter/Space on it) would ALSO fire onSelect
       on the row underneath it.
     - No such check is needed for onClick: EditableTitle's pencil button
       already stops its own click from propagating up to this row's
       onClick, covering both the mouse-click and the keyboard-activation-
       fires-a-real-click-event cases in one place. -------------------------------------------------------------------------- */

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
 *  rail without wrapping, matching SubmissionsView's toLocaleString use of
 *  en-US formatting for last-activity timestamps. */
function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  onRename,
  isEditable = true,
}: ConversationListItemProps) {
  const { title, updatedAt, messageCount } = conversation;
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
        <span className="tutor-conversation-item__meta">
          <span className="tutor-conversation-item__time">{formatUpdatedAt(updatedAt)}</span>
          <span
            className="tutor-conversation-item__count"
            aria-label={`${messageCount} message${messageCount === 1 ? "" : "s"}`}
          >
            {messageCount}
          </span>
        </span>
      </div>
    </li>
  );
}
