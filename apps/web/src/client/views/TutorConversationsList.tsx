import { CaretDoubleLeft, CaretDoubleRight, ChatCircleDots, Plus } from "@phosphor-icons/react";
import { useTutorConversations } from "../hooks/useTutorConversations";
import { ConversationListItem } from "../components/ConversationListItem";

/* --------------------------------------------------------------------------
   TutorConversationsList — the tutor-conversations rail (#4).

   IA decision (see task-4-report.md for the full writeup): a second,
   visually distinct collapsible sidebar zone sitting between the homework
   Sidebar and the chat column -- not a new top-level route. The homework
   Sidebar is course+homework-scoped (a syllabus); this rail is course-scoped
   only (a thread list) and deliberately does NOT reuse the Husky-Purple
   Sidebar surface, matching the issue's own note that the two "may warrant
   a different surface." It DOES reuse the exact same collapse mechanic --
   a chevron toggle + a `sidebar--collapsed`-equivalent width transition,
   persisted to localStorage by the caller (App.tsx) under its own key --
   because the issue's "Responsive behavior" requirement asks to match that
   pattern, not invent a new one. This app has no CSS breakpoints at all yet
   (grep confirms zero @media rules in packages/ui/styles.css), so "responsive"
   here means this same collapse-by-choice mechanic, not viewport queries.
   -------------------------------------------------------------------------- */

export interface TutorConversationsListProps {
  /** Undefined while the homework list (the client's only source of course
   *  context, see StudentHomeworkSummary.courseId) hasn't loaded yet. */
  courseId: string | undefined;
  selectedConversationId: string | undefined;
  /** Fired when an existing row is clicked. */
  onSelectConversation: (conversationId: string) => void;
  /** Fired after a new conversation is successfully created and selected
   *  locally -- lets the parent switch the chat column to the tutor
   *  surface without this component knowing about that concept. */
  onConversationCreated: (conversationId: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function TutorConversationsList({
  courseId,
  selectedConversationId,
  onSelectConversation,
  onConversationCreated,
  isCollapsed,
  onToggleCollapse,
}: TutorConversationsListProps) {
  const { conversations, loading, loadError, createConversation } = useTutorConversations(courseId);

  const handleCreate = async () => {
    const created = await createConversation();
    if (created) onConversationCreated(created.id);
  };

  return (
    <nav
      className={isCollapsed ? "tutor-sidebar sidebar--collapsed" : "tutor-sidebar"}
      aria-label="Tutor conversations"
    >
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
      >
        <Plus size={14} weight="regular" aria-hidden="true" />
        <span className="tutor-sidebar__new-btn-label">New conversation</span>
      </button>

      {/* Only a genuinely-empty API response ([]) gets the empty state --
          while a fetch is in flight (loading, and nothing loaded yet), show
          nothing rather than an empty state that would flash then vanish,
          matching pitfall #3's "do not show a loading spinner if the list
          is truly empty" by not showing either state prematurely. */}
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
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
