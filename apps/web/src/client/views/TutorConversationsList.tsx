import { useEffect } from "react";
import { CaretDoubleLeft, CaretDoubleRight, ChatCircleDots, Plus } from "@phosphor-icons/react";
import { useTutorConversations } from "../hooks/useTutorConversations";
import { ConversationListItem } from "../components/ConversationListItem";
import type { ConversationListItemResponse } from "../../shared/types";

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
   pattern, not invent a new one. This app has no viewport-width media
   queries at all yet -- the only @media rules anywhere in
   packages/ui/styles.css are `prefers-reduced-motion`, not layout
   breakpoints (corrected during code review: an earlier version of this
   comment claimed zero @media rules of any kind, which was wrong) -- so
   "responsive" here means this same collapse-by-choice mechanic, not a
   viewport breakpoint that doesn't exist yet.
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
  /** #6: fires whenever the selected conversation's data changes (initial
   *  load, a different row selected, or a rename resolving) -- lets the
   *  parent (App.tsx) mirror the currently-active tutor conversation's
   *  title into the chat column's header without this component needing
   *  to know that header exists. Undefined when nothing is selected, or
   *  selectedConversationId doesn't (yet) match any loaded row. */
  onSelectedConversationChange?: (conversation: ConversationListItemResponse | undefined) => void;
  /** #6: hands the parent this hook instance's renameConversation function
   *  once it's available (and again whenever it's recreated) -- so the
   *  chat column's header (rendered by App.tsx, not this component) can
   *  rename the SAME conversation this list displays through the SAME
   *  hook instance/state, rather than duplicating fetch+optimistic-update
   *  logic in a second place that could drift out of sync with this row's
   *  own display. */
  onRenameHandlerReady?: (
    renameConversation: (id: string, title: string) => Promise<ConversationListItemResponse>,
  ) => void;
}

export function TutorConversationsList({
  courseId,
  selectedConversationId,
  onSelectConversation,
  onConversationCreated,
  isCollapsed,
  onToggleCollapse,
  onSelectedConversationChange,
  onRenameHandlerReady,
}: TutorConversationsListProps) {
  const { conversations, loading, loadError, createConversation, renameConversation } =
    useTutorConversations(courseId);

  const handleCreate = async () => {
    const created = await createConversation();
    if (created) onConversationCreated(created.id);
  };

  useEffect(() => {
    onRenameHandlerReady?.(renameConversation);
  }, [renameConversation, onRenameHandlerReady]);

  useEffect(() => {
    onSelectedConversationChange?.(conversations.find((c) => c.id === selectedConversationId));
  }, [conversations, selectedConversationId, onSelectedConversationChange]);

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
              onRename={async (title) => {
                await renameConversation(conv.id, title);
              }}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
