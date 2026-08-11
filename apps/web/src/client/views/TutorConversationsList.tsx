import { useState } from "react";
import { CaretDoubleLeft, CaretDoubleRight, ChatCircleDots, Plus } from "@phosphor-icons/react";
import { ConversationListItem } from "../components/ConversationListItem";
import type { ConversationListItemResponse } from "../../shared/types";

/* --------------------------------------------------------------------------
   TutorConversationsList — the tutor-conversations rail (#4).

   A second, visually distinct collapsible sidebar zone sitting between the
   homework Sidebar and the chat column -- not a new top-level route (see
   task-4-report.md for the full IA writeup). It reuses the homework
   Sidebar's collapse mechanic (chevron toggle, width transition, state
   persisted by the caller under its own localStorage key) but is otherwise
   a distinct surface.

   Presentational (#223): owns no data-fetching of its own. `conversations`/
   `loading`/`loadError` and the create/rename actions all come from a
   single `useTutorConversations` instance App.tsx owns and shares with the
   chat column's header -- moved there specifically so this component and
   the chat column read/write the exact same state rather than syncing two
   copies through a ref-handoff.
   -------------------------------------------------------------------------- */

export interface TutorConversationsListProps {
  /** Undefined while the homework list (the client's only source of course
   *  context) hasn't loaded yet. */
  courseId: string | undefined;
  /** #232: true while that homework fetch is still in flight -- lets the
   *  disabled "New conversation" button distinguish "give it a moment"
   *  from "there's genuinely no course to scope this to." */
  courseContextLoading: boolean;
  conversations: ConversationListItemResponse[];
  loading: boolean;
  loadError: boolean;
  selectedConversationId: string | undefined;
  /** Fired when an existing row is clicked. */
  onSelectConversation: (conversationId: string) => void;
  /** Creates a new conversation (and, on success, selects/switches to it --
   *  owned by the caller). Returns whether it succeeded; this component
   *  surfaces a visible failure itself (#235) rather than failing silently. */
  onCreateConversation: () => Promise<boolean>;
  /** Return value ignored -- callers may resolve it to the updated
   *  conversation (useTutorConversations' own renameConversation does) or
   *  to nothing; this component only awaits it. */
  onRenameConversation: (id: string, title: string) => Promise<unknown>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function TutorConversationsList({
  courseId,
  courseContextLoading,
  conversations,
  loading,
  loadError,
  selectedConversationId,
  onSelectConversation,
  onCreateConversation,
  onRenameConversation,
  isCollapsed,
  onToggleCollapse,
}: TutorConversationsListProps) {
  // #235: visible + announced create-failure message (reuses the same
  // .tutor-sidebar__error role="alert" element the list-load failure uses,
  // rather than a second, differently-styled error surface) and a polite
  // live region for non-error status changes (create success, rename
  // success, loading) that don't otherwise interrupt anything.
  const [createError, setCreateError] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState("");

  const handleCreate = async () => {
    setCreateError(null);
    const ok = await onCreateConversation();
    if (ok) {
      setLiveMessage("Conversation created");
    } else {
      setCreateError("Couldn't create a new conversation. Please try again.");
    }
  };

  const disabledReasonId = "tutor-sidebar-new-btn-reason";
  const disabledReason = courseContextLoading
    ? "Loading course information…"
    : "No course selected yet — new conversations aren't available.";

  return (
    <nav
      className={isCollapsed ? "tutor-sidebar sidebar--collapsed" : "tutor-sidebar"}
      aria-label="Tutor conversations"
    >
      {/* #235: announces create/rename outcomes and loading transitions --
          visually hidden, doesn't duplicate what role="alert" already
          announces for the two error states below. */}
      <div aria-live="polite" className="sr-only">
        {loading ? "Loading conversations…" : liveMessage}
      </div>

      <div className="tutor-sidebar__top">
        <button
          className="tutor-sidebar__collapse-toggle"
          type="button"
          aria-label={isCollapsed ? "Expand tutor conversations" : "Collapse tutor conversations"}
          aria-expanded={!isCollapsed}
          onClick={onToggleCollapse}
        >
          {isCollapsed ? <CaretDoubleRight size={14} weight="regular" /> : <CaretDoubleLeft size={14} weight="regular" />}
        </button>
      </div>

      <p className="tutor-sidebar__label">Tutor Chats</p>

      <button
        type="button"
        className="tutor-sidebar__new-btn"
        onClick={handleCreate}
        disabled={!courseId}
        aria-label="New conversation"
        aria-describedby={!courseId ? disabledReasonId : undefined}
        title={!courseId ? disabledReason : undefined}
      >
        <Plus size={14} weight="regular" aria-hidden="true" />
        <span className="tutor-sidebar__new-btn-label">New conversation</span>
      </button>
      {/* #232: explains WHY the button is disabled instead of leaving it a
          silent dead end -- distinct message for "still loading" vs
          "nothing to scope to," visually hidden (the title attribute above
          is the sighted-mouse-user affordance) but reachable via
          aria-describedby either way. */}
      {!courseId && (
        <p id={disabledReasonId} className="sr-only">
          {disabledReason}
        </p>
      )}

      {createError && (
        <p className="tutor-sidebar__error" role="alert">
          {createError}
        </p>
      )}

      {/* Only a genuinely-empty API response ([]) gets the empty state --
          while a fetch is in flight (loading, and nothing loaded yet), show
          nothing rather than an empty state that would flash then vanish. */}
      {loadError && (
        <p className="tutor-sidebar__error" role="alert">
          Couldn't load conversations.
        </p>
      )}

      {!loadError && !loading && conversations.length === 0 && (
        <div className="tutor-sidebar__empty">
          <ChatCircleDots size={20} weight="regular" aria-hidden="true" />
          <p>No conversations yet</p>
        </div>
      )}

      {conversations.length > 0 && (
        <ul className="tutor-sidebar__list" aria-label="Tutor conversation list">
          {conversations.map((conv) => (
            <ConversationListItem
              key={conv.id}
              conversation={conv}
              isSelected={conv.id === selectedConversationId}
              onSelect={() => onSelectConversation(conv.id)}
              onRename={async (title) => {
                await onRenameConversation(conv.id, title);
                setLiveMessage(`Renamed to ${title}`);
              }}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
