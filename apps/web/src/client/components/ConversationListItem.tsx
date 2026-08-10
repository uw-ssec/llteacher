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

   #6: this row used to be ONE big <button> -- clicking anywhere (including
   the title text) selected the conversation. Renaming needed the title
   itself to become its own click target ("click the title... enters edit
   mode", per the issue), which can't share a click handler with "select
   this row" without one interaction swallowing the other. So the row is
   now a plain <div> containing two sibling interactive controls:
     - EditableTitle (title) -- click enters rename mode. Its own trigger
       button calls stopPropagation() internally, so clicking it never
       also selects the row.
     - .tutor-conversation-item__meta-btn (time + message count) -- the
       real, keyboard-reachable "select this conversation" control.
   The row div also keeps onClick={onSelect} as a mouse-only convenience
   (clicking padding/background still selects) but isn't itself part of
   the accessibility tree as an interactive element -- the meta button is
   the sanctioned keyboard/AT path for selecting, exactly mirroring what
   the single big <button> gave keyboard users before this split. */

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
        onClick={onSelect}
      >
        <EditableTitle
          value={title}
          onSave={onRename}
          isEditable={isEditable}
          className="tutor-conversation-item__title"
        />
        <button
          type="button"
          className="tutor-conversation-item__meta-btn"
          aria-current={isSelected ? "true" : undefined}
          aria-label={`Select conversation: ${title}`}
          onClick={(e) => {
            // Redundant with the row div's own onClick=onSelect above for
            // mouse users, but this is the actual keyboard/AT-reachable
            // control (see this file's doc comment) -- stopPropagation
            // just avoids onSelect firing twice for a single mouse click.
            e.stopPropagation();
            onSelect();
          }}
        >
          <span className="tutor-conversation-item__meta">
            <span className="tutor-conversation-item__time">{formatUpdatedAt(updatedAt)}</span>
            <span
              className="tutor-conversation-item__count"
              aria-label={`${messageCount} message${messageCount === 1 ? "" : "s"}`}
            >
              {messageCount}
            </span>
          </span>
        </button>
      </div>
    </li>
  );
}
