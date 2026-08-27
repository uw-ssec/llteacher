import { useEffect, useRef, useState } from "react";
import { CaretDoubleLeft, CaretDoubleRight, Plus } from "@phosphor-icons/react";
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
  /** #293: true whenever there is no `courseId` yet -- either the homework
   *  fetch is in flight or the student is in no course at all. Gates the
   *  empty state: "not loading, no error, zero rows" used to be reachable
   *  before course context existed, so a returning student was told "No
   *  conversations yet" for a round-trip on every page load. */
  awaitingCourseContext: boolean;
  loadError: boolean;
  /** #310: retries a failed list load. The rail no longer clears itself on
   *  a failed fetch, so this is offered alongside whatever was last loaded
   *  rather than next to an empty list. */
  onRetryLoad: () => void;
  /** #280: true when the server has more conversations than this list
   *  fetched (the list route pages at 50, no load-more is wired yet) --
   *  renders a visible note below the list so the page ceiling is visible
   *  rather than silent (an empty-looking tail otherwise looks identical to
   *  "I have exactly N conversations"). */
  hasMore: boolean;
  selectedConversationId: string | undefined;
  /** #290: the row whose history is being fetched right now, if any. */
  pendingConversationId?: string | undefined;
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
  awaitingCourseContext,
  loadError,
  onRetryLoad,
  hasMore,
  selectedConversationId,
  pendingConversationId,
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

  /* #290: selection -- the rail's primary action -- was the one thing the
     #235 live region did not cover. It announced create, rename and
     list-loading, so a screen-reader user activating a row heard nothing
     for several seconds and was never told the transcript had changed,
     even though both ErrorBoundary and ConversationView are keyed on the
     id and the entire chat column unmounts and remounts underneath them.

     Derived rather than stored: `pendingConversationId` and
     `selectedConversationId` already carry everything needed, and a
     separate piece of state would just be a second source of truth to keep
     in step with them. */
  /* #399: selection announcements go through the SAME `liveMessage` state
     as create and rename, rather than a derived value that shadows it.

     The previous shape was `selectionMessage ?? liveMessage`, and
     `selectionMessage` was derived from `selectedConversationId` -- so once
     anything was selected it was permanently `Opened X`, and every
     subsequent "Conversation created" / "Renamed to X" was masked for the
     rest of the session. That silently regressed #235's existing feedback
     inside the PR meant to improve this surface's screen-reader support.

     One piece of state means one ordering: whatever happened most recently
     is what gets announced, whichever action it came from. */
  const pendingTitle = conversations.find((c) => c.id === pendingConversationId)?.title;
  const selectedTitle = conversations.find((c) => c.id === selectedConversationId)?.title;

  /* One effect owning the whole pending -> settled/cancelled transition.

     Splitting it in two left a hole: when a pending selection was CANCELLED
     (the student navigated to a homework section, so pendingConversationId
     and selectedConversationId both cleared), neither branch wrote anything
     and the live region stayed stuck on "Loading conversation X…"
     indefinitely. The same happened after a successful hydration retry,
     where the selected id had not changed so the second effect stayed
     silent. My "deliberately no else" comment was the bug: every exit from
     pending needs an announcement, not just the one that opens something
     new. */
  const previousPendingRef = useRef(pendingConversationId);
  const previousSelectionRef = useRef(selectedConversationId);
  useEffect(() => {
    const wasPending = previousPendingRef.current;
    previousPendingRef.current = pendingConversationId;
    const previousSelection = previousSelectionRef.current;
    previousSelectionRef.current = selectedConversationId;

    if (pendingConversationId) {
      setLiveMessage(`Loading conversation${pendingTitle ? ` ${pendingTitle}` : ""}…`);
      return;
    }

    if (selectedConversationId && selectedConversationId !== previousSelection) {
      setLiveMessage(`Opened ${selectedTitle ?? "conversation"}`);
      return;
    }

    // Pending ended without opening anything new: cancelled, or a retry
    // that landed on the conversation already showing. Either way the
    // "Loading…" line must not persist.
    if (wasPending) {
      setLiveMessage(selectedConversationId ? `Opened ${selectedTitle ?? "conversation"}` : "");
    }
  }, [pendingConversationId, pendingTitle, selectedConversationId, selectedTitle]);

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
          "nothing to scope to."

          #293: now VISIBLE. #232 delivered this reason through `title`
          (hover only -- never fires on touch) and an `sr-only` paragraph
          (assistive tech only), so no sighted student on a tablet, or one
          who simply clicks without hovering, ever saw it: the button did
          nothing and said nothing. The copy and the two-way distinction
          were already right; only the visibility was wrong. `title` stays
          for the mouse-hover affordance and aria-describedby still points
          here, so nothing that worked before stops working. */}
      {!courseId && (
        <p id={disabledReasonId} className="tutor-sidebar__disabled-reason">
          {disabledReason}
        </p>
      )}

      {createError && (
        <p className="tutor-sidebar__error" role="alert">
          {createError}
        </p>
      )}

      {/* #310: a failed load no longer empties the rail, so this sits above
          whatever was last loaded. The copy says "couldn't refresh" rather
          than "couldn't load" precisely because the rows below it may still
          be there and still be usable -- just possibly stale. */}
      {loadError && (
        <div className="tutor-sidebar__error" role="alert">
          <p>
            {conversations.length > 0
              ? "Couldn't refresh conversations. These may be out of date."
              : "Couldn't load conversations."}
          </p>
          {/* #400: disabled while a load is in flight. `loadError` stays
              true until the retry resolves, so this button remained live
              and repeated clicks started concurrent refetches for the same
              course -- and the hook ordered responses by course id, not by
              request sequence, so an older response could overwrite a newer
              list or restore an error a later retry had already cleared. */}
          <button
            type="button"
            className="tutor-sidebar__retry"
            onClick={onRetryLoad}
            disabled={loading}
          >
            {loading ? "Retrying…" : "Try again"}
          </button>
        </div>
      )}

      {/* Staging's copy (#410's rail pass): one quiet left-aligned line
          rather than a decorative icon restating the button above it.

          #293 keeps its gate on top of it: `awaitingCourseContext` is what
          makes "a genuinely-empty API response" true. Before courseId has
          arrived this state is reachable with a full list on the server, so
          a returning student was told there was nothing here for one
          round-trip on every load. The copy changed; the condition it
          renders under still has to be right. */}
      {!loadError && !loading && !awaitingCourseContext && conversations.length === 0 && (
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
              isPending={conv.id === pendingConversationId}
              onSelect={() => onSelectConversation(conv.id)}
              onRename={async (title) => {
                await onRenameConversation(conv.id, title);
                setLiveMessage(`Renamed to ${title}`);
              }}
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
      {!loadError && hasMore && (
        <p className="tutor-sidebar__more-notice">
          Showing your most recent {conversations.length} conversations. Older ones aren't shown yet.
        </p>
      )}
    </nav>
  );
}
