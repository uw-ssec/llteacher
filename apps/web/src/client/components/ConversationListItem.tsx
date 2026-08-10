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
   -------------------------------------------------------------------------- */

export interface ConversationListItemProps {
  conversation: ConversationListItemResponse;
  isSelected: boolean;
  onSelect: () => void;
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

export function ConversationListItem({ conversation, isSelected, onSelect }: ConversationListItemProps) {
  const { title, updatedAt, messageCount } = conversation;
  return (
    <li className="tutor-conversation-item-wrap">
      <button
        type="button"
        className={
          isSelected
            ? "tutor-conversation-item tutor-conversation-item--selected"
            : "tutor-conversation-item"
        }
        aria-current={isSelected ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="tutor-conversation-item__title">{title}</span>
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
    </li>
  );
}
