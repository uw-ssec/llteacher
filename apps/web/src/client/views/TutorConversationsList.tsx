import { useState } from "react";
import { CaretDoubleLeft, CaretDoubleRight, Plus } from "@phosphor-icons/react";
import { AlertDialog } from "@llteacher/ui";
import { ConversationListItem } from "../components/ConversationListItem";
import type { ConversationListItemResponse } from "../../shared/types";

/* --------------------------------------------------------------------------
   TutorConversationsList — the tutor-conversations rail (#4).

   A second, visually distinct collapsible sidebar zone sitting between the
   homework Sidebar and the chat column -- not a new top-level route. #301:
   inlined here (a prior version of this comment pointed at a task-4-report.md
   that was never actually committed on any branch). Kept as a sidebar zone
   rather than its own route so it can sit alongside the homework Sidebar and
   the active chat column at once -- a student switching between "my tutor
   conversations" and "the homework I'm working on" is a common back-and-forth
   this surface exists to make cheap, which a route change (full navigation,
   losing chat scroll position) would make more expensive than the tutor rail
   is worth. It reuses the homework Sidebar's collapse mechanic (chevron
   toggle, width transition, state persisted by the caller under its own
   localStorage key) but is otherwise a distinct surface.

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
  /** #280: true when the server has more conversations than this list
   *  fetched (the list route pages at 50, no load-more is wired yet) --
   *  renders a visible note below the list so the page ceiling is visible
   *  rather than silent (an empty-looking tail otherwise looks identical to
   *  "I have exactly N conversations"). */
  hasMore: boolean;
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
  /** #289: soft-deletes a conversation. Returns whether it succeeded, so
   *  this component can surface a failure itself the same way it does for
   *  create. Omitted hides the delete affordance entirely. */
  onDeleteConversation?: (id: string) => Promise<boolean>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function TutorConversationsList({
  courseId,
  courseContextLoading,
  conversations,
  loading,
  loadError,
  hasMore,
  selectedConversationId,
  onSelectConversation,
  onCreateConversation,
  onRenameConversation,
  onDeleteConversation,
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

  /* #289: the row awaiting confirmation, if any. Deletion is soft
     server-side but irreversible from this UI -- there is no undo and no
     trash view -- so it is confirmed rather than done on one click, and the
     dialog names the conversation so a mis-clicked row is caught before it
     matters, not after. */
  /* Two pieces, deliberately: `deleteTarget` is what the dialog RENDERS and
     survives the close so its copy does not vanish mid-transition;
     `deleteOpen` is whether it is showing. Driving the dialog by mounting it
     meant cancelling removed an open native <dialog> outright, so
     AlertDialog's controlled dialog.close() never ran and focus dropped to
     <body> instead of returning to the delete trigger. */
  const [deleteTarget, setDeleteTarget] = useState<ConversationListItemResponse | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (!deleteTarget || !onDeleteConversation) return;
    setDeleting(true);
    const ok = await onDeleteConversation(deleteTarget.id);
    setDeleting(false);
    if (ok) {
      setLiveMessage(`Deleted ${deleteTarget.title}`);
      setDeleteError(null);
      setDeleteOpen(false);
    } else {
      // Dialog stays open: the row is still there, and closing it would
      // leave the student unsure whether the delete happened.
      setDeleteError("Couldn't delete that conversation. Please try again.");
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

      {/* Was a centred ChatCircleDots icon stacked over a centred "No
          conversations yet" caption -- the stock empty-state shape, and the
          decorative icon restated the "New conversation" button directly
          above it. One quiet left-aligned line in the rail's own mono label
          register instead, saying the one thing the button does not: where
          these conversations come from. */}
      {!loadError && !loading && conversations.length === 0 && (
        <p className="tutor-sidebar__empty">Start one to ask about anything outside a section.</p>
      )}

      {/* #295: list-style: none strips list semantics in Safari/VoiceOver
          without an explicit role="list" -- restoring it here since this
          surface took the "title becomes a real button" alternative, not
          the role="listbox" route (which would supersede this). */}
      {conversations.length > 0 && (
        <ul className="tutor-sidebar__list" role="list" aria-label="Tutor conversation list">
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
              onRequestDelete={
                onDeleteConversation
                  ? () => {
                      // #402: a failure recorded against a previous row must
                      // not be shown alongside this one.
                      setDeleteError(null);
                      setDeleteTarget(conv);
                      setDeleteOpen(true);
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      {/* #280: the list route pages at 50 with no load-more wired yet --
          without this, the 51st-oldest conversation is silently
          unreachable (an empty-looking tail is indistinguishable from "I
          have exactly 50 conversations"). Static text, not a live region:
          it's present at initial render, not something that appears mid-
          interaction and needs to interrupt anything. */}
      {/* Mounted whenever a delete has been requested this session, and
          driven by `open` rather than by mounting/unmounting.

          Conditionally mounting it meant cancelling REMOVED an open native
          <dialog> outright, so AlertDialog's controlled dialog.close() path
          never ran and the browser dropped focus to <body> instead of
          restoring it to the delete trigger that is still sitting there.
          Keeping it mounted through an open={false} transition lets that
          path run. */}
      {deleteTarget && (
        <AlertDialog
          open={deleteOpen}
          title="Delete this conversation?"
          description={
            deleteError ? (
              <>
                {/* role="alert": focus stays inside the open dialog while
                    the request runs, and swapping the text of an
                    aria-describedby target is not reliably announced. The
                    existing restart dialog already marks its failure this
                    way -- matching it rather than inventing a quieter
                    variant. */}
                <p role="alert">{deleteError}</p>
                <p>&ldquo;{deleteTarget.title}&rdquo; has not been deleted.</p>
              </>
            ) : (
              <>
                <p>
                  &ldquo;{deleteTarget.title}&rdquo; and its messages will no longer appear here. This
                  can&rsquo;t be undone from the app.
                </p>
              </>
            )
          }
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            /* #402: AlertDialog disables its buttons and Escape while
               `confirming`, but a BACKDROP click still reaches onCancel --
               which would unmount the dialog mid-request. If the delete then
               failed, `deleteError` was stored with no dialog visible and
               could surface later against a different row. Ignoring
               cancellation while the request is in flight matches what the
               existing restart dialog does. */
            if (deleting) return;
            setDeleteOpen(false);
            setDeleteError(null);
          }}
          confirming={deleting}
        />
      )}

      {!loadError && hasMore && (
        <p className="tutor-sidebar__more-notice">
          Showing your most recent {conversations.length} conversations. Older ones aren't shown yet.
        </p>
      )}
    </nav>
  );
}
