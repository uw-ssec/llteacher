import { useEffect, useMemo, useRef, useState } from "react";
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
  /** #280: true when the server has older conversations than this list
   *  holds (the list route pages at 50). Renders the load-more button
   *  below the list; goes false once the last page has been loaded, at
   *  which point the affordance disappears because there is genuinely
   *  nothing left to ask for. */
  hasMore: boolean;
  /** #280 (requirement 2): fetches and appends the next (older) page.
   *  Replaces the interim "older ones aren't shown yet" notice this
   *  component used to render under `hasMore` -- that notice was the
   *  issue's own explicitly-sanctioned stand-in for "paging is out of
   *  scope", and stating it alongside a working Load older button would be
   *  false. Nothing is rendered once `hasMore` is false, which is the
   *  honest end state: everything is on screen. */
  onLoadMore: () => void;
  /** #280: true while `onLoadMore`'s request is in flight. */
  loadingMore: boolean;
  /** #280: true when the last load-more failed. Surfaced next to the
   *  button (which stays live, since the page is still there to ask for)
   *  rather than through the list-level error above -- everything already
   *  on screen is still valid. */
  loadMoreError: boolean;
  selectedConversationId: string | undefined;
  /** #290: the row whose history is being fetched right now, if any. */
  pendingConversationId?: string | undefined;
  /** #310: the id of a conversation just moved to the front of the list by
   *  a real reorder (see useTutorConversations' bumpConversation and its
   *  recentlyMovedId doc comment). Renders a brief highlight on that row;
   *  omitted or null renders no highlight at all. */
  recentlyMovedId?: string | null;
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
  awaitingCourseContext,
  loadError,
  onRetryLoad,
  hasMore,
  onLoadMore,
  loadingMore,
  loadMoreError,
  selectedConversationId,
  pendingConversationId,
  recentlyMovedId = null,
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

  /* #310: memoization support for the row list below.

     `now` is computed ONCE per mount, not per row per render -- it used to
     be a fresh `new Date()` built inside ConversationListItem's own
     formatUpdatedAt on every row on every render of this list, which
     happens on every streamed token in App.tsx (the chat state that
     triggers those renders lives above this whole rail). One Date per
     mount, reused by every row on every render, is what lets
     ConversationListItem's own React.memo below actually skip a row: a
     fresh object passed down every render would fail its shallow prop
     comparison regardless of memoization. The tradeoff this accepts is
     that the today/not-today boundary in each row's timestamp can go stale
     if a single browser tab stays open across midnight -- a existing
     conversation from just before midnight would keep reading as "11:58
     PM" instead of flipping to a dated format until the page is reloaded.
     Minor and cosmetic; not worth an interval or effect for.

     onSelectConversation/onRenameConversation are NOT wrapped in
     useCallback by App.tsx (they're plain functions recreated every
     render), so caching a per-row bound closure keyed only on those
     wouldn't be stable either. Refs holding the latest function let the
     cached, per-id wrapper below never need to change once created --
     it always calls through to whatever the ref currently holds. */
  const now = useMemo(() => new Date(), []);

  const onSelectConversationRef = useRef(onSelectConversation);
  onSelectConversationRef.current = onSelectConversation;
  const onRenameConversationRef = useRef(onRenameConversation);
  onRenameConversationRef.current = onRenameConversation;
  const onDeleteConversationRef = useRef(onDeleteConversation);
  onDeleteConversationRef.current = onDeleteConversation;
  // Read inside a cached delete handler, below, at CLICK time rather than
  // at the time the handler was first created -- a rename landing between
  // those two moments must not leave the delete-confirmation dialog naming
  // the row's old title.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // Per-id caches of bound handlers -- created once per conversation id,
  // reused across every subsequent render regardless of how many times
  // this component itself re-renders, so the identity ConversationListItem
  // receives for onSelect/onRename/onRequestDelete never changes and its
  // React.memo can actually compare equal. Entries for ids no longer in
  // `conversations` are simply never looked up again; left in the Map
  // rather than pruned, since a rail's conversation count is small enough
  // that this never becomes a real leak, and pruning would need its own
  // effect keyed on the list for no real benefit.
  const selectHandlersRef = useRef(new Map<string, () => void>());
  const renameHandlersRef = useRef(new Map<string, (newTitle: string) => Promise<void>>());
  const deleteHandlersRef = useRef(new Map<string, () => void>());

  const getSelectHandler = (id: string): (() => void) => {
    const cache = selectHandlersRef.current;
    let handler = cache.get(id);
    if (!handler) {
      handler = () => onSelectConversationRef.current(id);
      cache.set(id, handler);
    }
    return handler;
  };

  const getRenameHandler = (id: string): ((newTitle: string) => Promise<void>) => {
    const cache = renameHandlersRef.current;
    let handler = cache.get(id);
    if (!handler) {
      handler = async (newTitle: string) => {
        await onRenameConversationRef.current(id, newTitle);
        setLiveMessage(`Renamed to ${newTitle}`);
      };
      cache.set(id, handler);
    }
    return handler;
  };

  // #402: a delete request has to name and show the RIGHT row even though
  // this cached handler is built once and never rebuilt for a given id --
  // it reads `conversationsRef.current` (kept current above) at CLICK
  // time, not whatever the title was when the handler was first created,
  // so a rename landing in between doesn't leave the confirmation dialog
  // naming a stale title.
  const getDeleteHandler = (id: string): (() => void) | undefined => {
    if (!onDeleteConversationRef.current) return undefined;
    const cache = deleteHandlersRef.current;
    let handler = cache.get(id);
    if (!handler) {
      handler = () => {
        if (!onDeleteConversationRef.current) return;
        const conv = conversationsRef.current.find((c) => c.id === id);
        if (!conv) return;
        setDeleteError(null);
        setDeleteTarget(conv);
        setDeleteOpen(true);
      };
      cache.set(id, handler);
    }
    return handler;
  };

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
              isRecentlyMoved={conv.id === recentlyMovedId}
              now={now}
              onSelect={getSelectHandler(conv.id)}
              onRename={getRenameHandler(conv.id)}
              onRequestDelete={getDeleteHandler(conv.id)}
            />
          ))}
        </ul>
      )}

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

      {/* #280 (requirement 2): the real load-more affordance, replacing the
          interim notice that used to sit here. A button rather than
          infinite scroll: this rail has no scroll-position infrastructure
          to hang an observer off, and a student paging back through a
          term's conversations wants a deliberate step, not a list that
          keeps growing while they read it.

          Hidden alongside `loadError` for the same reason the notice was:
          `hasMore` describes the last SUCCESSFUL page, so offering "load
          older" next to "couldn't refresh" would invite a second request
          against a cursor whose list may already be stale -- Try again
          (which reloads from page 1) is the right control there. */}
      {!loadError && hasMore && (
        <div className="tutor-sidebar__more">
          <button
            type="button"
            className="tutor-sidebar__load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load older conversations"}
          </button>
          {loadMoreError && (
            <p className="tutor-sidebar__error" role="alert">
              Couldn&rsquo;t load older conversations. Please try again.
            </p>
          )}
        </div>
      )}
    </nav>
  );
}
