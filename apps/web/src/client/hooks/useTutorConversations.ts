import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationListItemResponse, ConversationListResponse, ConversationSummary } from "../../shared/types";

/* --------------------------------------------------------------------------
   useTutorConversations — fetches and manages a student's course-scoped
   "tutor" conversations (#4).

   Mirrors useStudentHomework's fetch-on-mount + explicit loadError shape
   (App.tsx) rather than throwing inside a .then chain on a non-ok response
   -- a 401/403 here must be distinguishable from "loaded, genuinely zero
   conversations."

   `courseId` is expected to come from the already-fetched homework summary
   (StudentHomeworkSummary.courseId) -- the client has no other source of
   course context today. Passing `undefined` is a valid "not loaded yet"
   state: the hook reports an empty list, loading: false, and skips the
   fetch/create network calls entirely rather than requesting with a
   malformed courseId.
   -------------------------------------------------------------------------- */

export interface UseTutorConversationsResult {
  conversations: ConversationListItemResponse[];
  loading: boolean;
  /** #293: true whenever there is no `courseId` to scope a query to -- the
   *  homework fetch that supplies it has not resolved, or the student is
   *  enrolled in no course at all. Distinct from `loading` because this
   *  hook cannot tell those two apart, and one of them never resolves.
   *
   *  Callers MUST gate the empty state on this being false. "not loading,
   *  no error, zero rows" was previously reachable before courseId ever
   *  arrived, so a returning student with eight conversations was told "No
   *  conversations yet" for one round-trip on every page load -- the first
   *  impression each time being that their work was gone. */
  awaitingCourseContext: boolean;
  /** True only when a fetch to a *known* courseId failed (network error or
   *  non-2xx) -- never true just because courseId hasn't loaded yet. */
  loadError: boolean;
  /** #280: true when the most recent page carried a non-null `nextCursor`
   *  -- there are older conversations the list does not hold yet. Goes
   *  false once `loadMore` has walked to the last page, so a caller can
   *  render its load-more affordance directly off this. */
  hasMore: boolean;
  /** #280: true while a `loadMore` request is in flight. */
  loadingMore: boolean;
  /** #280: true when the last `loadMore` failed. Cleared when the next one
   *  is attempted. Separate from `loadError` (which is about the page-1
   *  load): a failed load-more leaves everything already on screen valid,
   *  so it must not read as "the list is broken". */
  loadMoreError: boolean;
  /** #280: fetches the next page using the server's own opaque
   *  `nextCursor` (#281) and APPENDS it -- the rail is ordered
   *  updatedAt-desc, so the next page is always older than what is showing.
   *  A no-op when there is no cursor (last page reached), no courseId, or a
   *  load-more is already in flight. */
  loadMore: () => Promise<void>;
  /** Refetches the list from the server. Not called automatically after
   *  createConversation (that appends optimistically instead). */
  refetch: () => void;
  /** POSTs a new tutor conversation and prepends it to the local list.
   *  Returns the created conversation, or null if courseId isn't loaded
   *  yet or the request failed -- callers should treat null as "nothing to
   *  select," not throw. */
  createConversation: (title?: string) => Promise<ConversationListItemResponse | null>;
  /** PATCHes a conversation's title, optimistically updating the local
   *  list immediately (so both the list row AND any other consumer reading
   *  from this same `conversations` array, e.g. App.tsx's tutor chat
   *  header, reflect the new title without waiting on the network).
   *  Reconciles with the server's response on success. On failure, the
   *  optimistic update is rolled back to whatever this row's title was
   *  before the call, and the returned promise REJECTS (unlike
   *  createConversation's fails-open-with-null convention) -- EditableTitle
   *  (the caller) needs a rejection to know to show its own inline error
   *  and revert its displayed value; a null return would look identical to
   *  "saved successfully with no change." */
  renameConversation: (id: string, title: string) => Promise<ConversationListItemResponse>;
  /** #289: soft-deletes a conversation and removes its row from the local
   *  list. Returns whether it succeeded -- false lets the caller surface a
   *  failure rather than leaving a row that looks deleted but isn't.
   *
   *  The row is removed only AFTER the server confirms, not optimistically.
   *  Deletion is the one action here a student cannot undo from the UI, so
   *  a row that vanishes and then reappears on the next load is a worse
   *  outcome than a half-second delay -- the opposite of the tradeoff
   *  renameConversation makes, where an optimistic update is cheap because
   *  a failed rename rolls back to a value the student can still see. */
  deleteConversation: (id: string) => Promise<boolean>;
  /** #216: optimistically bumps a conversation's messageCount and
   *  updatedAt (and re-sorts by updatedAt desc, matching
   *  listConversationsForOwner's server-side ordering) -- called by App.tsx
   *  once a chat turn in this conversation completes. `/api/chat` writes
   *  bypass this hook entirely (it only knows about the CRUD routes), so
   *  without an explicit bump the rail's message count and position never
   *  reflect actual chat activity until a full reload re-fetches the list. */
  bumpConversation: (id: string) => void;
}

export function useTutorConversations(courseId: string | undefined): UseTutorConversationsResult {
  const [conversations, setConversations] = useState<ConversationListItemResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  /* #280: the server's own opaque cursor (#281), not a client-reconstructed
     one -- `hasMore` is derived from it rather than stored separately, so
     "there is another page" and "here is how to ask for it" can never
     disagree. `null` means the last page has been reached. */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  /* Read inside loadMore AFTER its own await, and to decide whether to
     start at all -- `nextCursor` captured in that useCallback's closure is
     frozen at creation (it is keyed on courseId, not on the cursor), so a
     second click would re-request the page it just fetched. */
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  /* Guards against a double-fired click starting two identical requests;
     a ref, not `loadingMore`, because it has to be readable synchronously
     at the top of the handler rather than one render later. */
  const loadingMoreRef = useRef(false);

  // #223: renameConversation needs to read the row being renamed BEFORE its
  // own optimistic update, to roll back to the right value on failure --
  // but reading it via `conversations` in that function's own closure would
  // make its identity (and therefore its useCallback deps) change on every
  // list update, including a #216 bump on a completely different row. A ref
  // mirrors `conversations` on every render instead: reading
  // conversationsRef.current is exactly as current as the last commit
  // `conversations` came from (the same freshness the original direct read
  // had), without renameConversation itself needing `conversations` as a
  // dependency.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  /* #388: the course scope as of the latest render. `refetch` is a
     useCallback keyed on courseId, so the `courseId` its body closes over is
     frozen at creation -- comparing a response against THAT would compare a
     value with itself and always agree. Every late-arriving response has to
     be checked against what the hook is scoped to NOW, which is what this
     ref carries. */
  const courseIdRef = useRef(courseId);
  courseIdRef.current = courseId;

  /** #400: monotonically increasing id per fetch this hook issues, so a
   *  late response can tell whether it is still the newest. */
  const requestSeqRef = useRef(0);

  /** Bumped by every LOCAL mutation (create, rename, delete, bump). A GET
   *  captured its snapshot server-side before any of these; if one has
   *  landed since the request was issued, replacing the list wholesale with
   *  that response silently reverts it.
   *
   *  Concretely: after a failed load a student can press Try again and then
   *  create a conversation -- the New button stays enabled. If the GET's
   *  snapshot predates the POST but resolves after it, `setConversations`
   *  removes the row they just created. Renames and message-count bumps
   *  revert the same way. */
  const mutationSeqRef = useRef(0);

  const refetch = useCallback(() => {
    if (!courseId) {
      // Not a fetch error -- there's simply no course to scope the query
      // to yet (homework list still loading, or the student has none).
      //
      // #293: this resolves `loading` to false, as it always did -- but the
      // empty state is no longer reachable from here, because
      // `awaitingCourseContext` is true whenever courseId is absent and the
      // list gates its empty state on that.
      //
      // Holding `loading` true instead was the other option the issue
      // offered, and it is wrong: courseId is undefined both while the
      // homework fetch is in flight AND permanently, for a student enrolled
      // in no course at all. That second case would spin forever. The flag
      // separates "the list is unknown" from "there is no course to list
      // for", which is the distinction the UI actually needs -- in both
      // no-courseId cases the honest thing to show is the disabled New
      // conversation button and its reason, never "No conversations yet".
      setConversations([]);
      setLoadError(false);
      setNextCursor(null);
      setLoadMoreError(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    // #388: the course this particular request belongs to. Every setter
    // below checks it, so a response arriving after a course switch cannot
    // write into the new course's state.
    const requestedCourseId = courseId;
    /* #400: response ordering. Guarding by course id alone lets two
       same-course requests (two Try again clicks) race, so an older
       response could overwrite a newer list or restore an error a later one
       had cleared. Every response checks it is still the newest request
       issued, not merely the right course. */
    const requestSeq = ++requestSeqRef.current;
    const mutationSeqAtRequest = mutationSeqRef.current;
    fetch(`/api/conversations?courseId=${encodeURIComponent(courseId)}&kind=tutor`)
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load tutor conversations: ${r.status}`);
        return r.json() as Promise<ConversationListResponse>;
      })
      .then((data) => {
        if (requestedCourseId !== courseIdRef.current || requestSeq !== requestSeqRef.current) return;
        /* A local mutation landed while this was in flight, so the server
           snapshot is older than what is on screen. Keeping the local list
           is the conservative choice: it may be missing another device's
           changes until the next load, but it cannot delete a row the
           student just created in front of them. `loadError` is still worth
           taking -- it is not invalidated by a local edit. The cursor is
           (see below), so it travels with the rows. */
        const stale = mutationSeqAtRequest !== mutationSeqRef.current;
        if (!stale) {
          setConversations(data.items);
          setNextCursor(data.nextCursor);
        }
        /* #281: the route returns { items, nextCursor } instead of a bare
           array. #280: the cursor is kept, not just reduced to a boolean --
           `loadMore` echoes this exact opaque value back as the next
           request's `before`, which is the whole point of the server
           emitting it (a client-reconstructed cursor off a
           millisecond-truncated `updatedAt` was the precision-loss half of
           #281's bug).

           A refetch is a reload from page 1, so it RESETS pagination:
           whatever `loadMore` had walked to is replaced by this response's
           own cursor, matching the page-1 list that replaced the rows.
           Set above, inside the same `!stale` branch as the rows -- the
           cursor describes the TAIL of the list this response carried, so
           taking it while keeping a different (locally-mutated, possibly
           load-more-extended) list would point `before` at a row that is
           not this list's tail. Unlike `loadError`, it is invalidated by
           declining the rows it came with. */
        setLoadMoreError(false);
        setLoadError(false);
      })
      .catch((err: unknown) => {
        // #310: the list is deliberately NOT cleared on a same-course
        // failure. This used to setConversations([]), so a single 502 during
        // a deploy emptied the rail for the rest of the session and the
        // student's conversations looked deleted. Keeping the last known
        // good list means a transient failure degrades to "possibly stale"
        // rather than "apparently destroyed".
        //
        // #388: but only for the SAME course. `refetch` is keyed on
        // courseId and the effect below is keyed on `[refetch]`, so it also
        // re-runs on a course switch -- and retaining across that showed the
        // PREVIOUS course's conversations, selectable, while the rest of the
        // UI had moved on. Rows from another course are not stale, they are
        // wrong, and the "may be out of date" notice understates that. The
        // guard is the courseId this request was issued for, captured above,
        // not the current one: a slow request for course A resolving after a
        // switch to B must not clear B's list either.
        console.error("[useTutorConversations.refetch]", err);
        if (requestedCourseId !== courseIdRef.current || requestSeq !== requestSeqRef.current) return;
        setLoadError(true);
      })
      .finally(() => {
        if (requestedCourseId === courseIdRef.current && requestSeq === requestSeqRef.current) setLoading(false);
      });
  }, [courseId]);

  useEffect(() => {
    /* #388: drop the previous course's rows BEFORE the new request starts.
       Retaining across a failure is right for a same-course refresh and
       wrong here -- without this, a course switch whose fetch is slow (or
       fails) leaves the old course's conversations on screen and
       selectable. `loadError` is cleared too: an error belonging to the
       previous scope says nothing about this one. */
    setConversations([]);
    setNextCursor(null);
    setLoadMoreError(false);
    setLoadError(false);
    refetch();
  }, [refetch]);

  /* #280 (requirement 2, rail half): the actual load-more request. Appends
     rather than replaces -- the list is updatedAt-desc, so every page after
     the first is strictly older than what is already on screen.

     `before` is the server's own opaque cursor verbatim. This hook never
     constructs one: #281 moved the list to a compound (updatedAt, id)
     cursor precisely because a client-side reconstruction off a
     millisecond-truncated `updatedAt.toISOString()` silently dropped rows
     at a page boundary. */
  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = nextCursorRef.current;
    if (!courseId || cursor === null || loadingMoreRef.current) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    const requestedCourseId = courseId;
    /* Not a new request seq of its own: this reads whatever page-1 request
       was current when the click happened, so a refetch landing mid-flight
       (which resets the list AND the cursor to page 1) invalidates this
       page. Appending it afterwards would splice a page taken from the
       PREVIOUS list's tail onto a list that no longer ends there. */
    const requestSeqAtRequest = requestSeqRef.current;
    try {
      const res = await fetch(
        `/api/conversations?courseId=${encodeURIComponent(courseId)}&kind=tutor&before=${encodeURIComponent(cursor)}`,
      );
      if (!res.ok) throw new Error(`failed to load more tutor conversations: ${res.status}`);
      const data = (await res.json()) as ConversationListResponse;
      if (requestedCourseId !== courseIdRef.current || requestSeqAtRequest !== requestSeqRef.current) return;
      setConversations((prev) => {
        /* Defensive de-dupe. The compound cursor (#281) makes a duplicate
           across a page boundary impossible on the server side, but a row
           bumped to the top by a chat turn between the two requests can
           legitimately come back in a later page having already been
           rendered from an earlier one -- the mutable-sort-key caveat #281
           documents but does not (and cannot, without a snapshot) remove.
           Duplicate React keys would be the visible symptom. */
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...data.items.filter((c) => !seen.has(c.id))];
      });
      setNextCursor(data.nextCursor);
    } catch (err: unknown) {
      console.error("[useTutorConversations.loadMore]", err);
      if (requestedCourseId !== courseIdRef.current || requestSeqAtRequest !== requestSeqRef.current) return;
      /* Deliberately does NOT clear the cursor: the page that failed is
         still there to ask for, so the affordance stays and Try again is
         just another click on it. */
      setLoadMoreError(true);
    } finally {
      loadingMoreRef.current = false;
      if (requestedCourseId === courseIdRef.current) setLoadingMore(false);
    }
  }, [courseId]);

  const createConversation = useCallback(
    async (title?: string): Promise<ConversationListItemResponse | null> => {
      if (!courseId) return null;
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(title ? { courseId, title } : { courseId }),
        });
        if (!res.ok) throw new Error(`failed to create conversation: ${res.status}`);
        // POST's response is a plain ConversationSummary -- messageCount
        // doesn't exist yet on a conversation that was just created with no
        // messages, so it's filled in as 0 rather than left undefined.
        const created = (await res.json()) as ConversationSummary;
        const withCount: ConversationListItemResponse = { ...created, messageCount: 0 };
        // Prepended, not re-fetched: matches listConversationsForOwner's
        // desc(updatedAt) ordering (a brand-new conversation is always the
        // most recently updated) without an extra round-trip.
        mutationSeqRef.current += 1;
        setConversations((prev) => [withCount, ...prev]);
        return withCount;
      } catch (err: unknown) {
        // #310: was a bare `catch { return null; }`. The student does see
        // the failure, but nobody debugging one did -- unlike the rename and
        // list paths, which already log. Fails open with null as before.
        console.error("[useTutorConversations.createConversation]", err);
        return null;
      }
    },
    [courseId],
  );

  const deleteConversation = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      // 404 counts as success here -- the row is gone either way, and
      // keeping it on screen because someone deleted it in another tab
      // would be the wrong reading of "failed".
      if (!res.ok && res.status !== 404) {
        throw new Error(`failed to delete conversation: ${res.status}`);
      }
      mutationSeqRef.current += 1;
      setConversations((prev) => prev.filter((c) => c.id !== id));
      return true;
    } catch (err: unknown) {
      console.error("[useTutorConversations.deleteConversation]", err);
      return false;
    }
  }, []);

  const renameConversation = useCallback(async (id: string, title: string): Promise<ConversationListItemResponse> => {
    const previousRow = conversationsRef.current.find((c) => c.id === id);

    // Optimistic update -- applied synchronously, before the PATCH even
    // goes out.
    mutationSeqRef.current += 1;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));

    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        // Prefer the server's own message (updateConversationHandler's
        // "title is required and must be 1-100 chars after trimming", or a
        // 404 "Conversation not found") over a generic status code -- it's
        // what EditableTitle will show inline.
        let message = `failed to rename conversation: ${res.status}`;
        try {
          const errBody = (await res.json()) as { error?: string };
          if (errBody?.error) message = errBody.error;
        } catch {
          /* non-JSON error body -- fall back to the generic message */
        }
        throw new Error(message);
      }
      // PATCH's response is a plain ConversationSummary, same shape as
      // POST's -- messageCount isn't in it, so it's carried forward from
      // the row being renamed rather than defaulted to 0 (unlike a
      // brand-new conversation, this row may well have messages already).
      const updated = (await res.json()) as ConversationSummary;
      const withCount: ConversationListItemResponse = {
        ...updated,
        messageCount: previousRow?.messageCount ?? 0,
      };
      setConversations((prev) => prev.map((c) => (c.id === id ? withCount : c)));
      return withCount;
    } catch (err) {
      // Roll back the optimistic update -- this row goes back to whatever
      // it was before this call, not the failed attempt.
      setConversations((prev) => prev.map((c) => (c.id === id && previousRow ? previousRow : c)));
      throw err instanceof Error ? err : new Error("failed to rename conversation");
    }
  }, []);

  const bumpConversation = useCallback((id: string) => {
    mutationSeqRef.current += 1;
    setConversations((prev) => {
      const index = prev.findIndex((c) => c.id === id);
      if (index === -1) return prev;

      const now = new Date().toISOString();
      const next = prev.map((c) => (c.id === id ? { ...c, messageCount: c.messageCount + 1, updatedAt: now } : c));

      /* #310: two problems with re-sorting here, both fixed by not doing it
         in the usual case.

         The rail re-sorted the WHOLE list on every completed turn. Almost
         always a no-op -- the conversation being talked to is already at
         the top, because talking to it is what put it there -- but it
         reordered rows underneath a student who might be reading them.

         And the comparator mixed sources: this optimistic `now` is the
         CLIENT's clock, while every other row's updatedAt came from the
         server. A client running even slightly behind produced a row that
         sorted below conversations it had just overtaken, so a turn could
         push the active conversation DOWN the list.

         Moving the bumped row to the front directly sidesteps both: it is
         what desc(updatedAt) would have produced anyway (this row was just
         touched, so it is the most recently updated by definition), it
         leaves every other row's relative order exactly as the server sent
         it, and it never compares a client timestamp against a server one.
         When the row is already first -- the overwhelmingly common case --
         nothing moves at all. */
      if (index === 0) return next;
      const bumped = next[index]!;
      return [bumped, ...next.slice(0, index), ...next.slice(index + 1)];
    });
  }, []);

  return {
    conversations,
    loading,
    awaitingCourseContext: courseId === undefined,
    loadError,
    hasMore: nextCursor !== null,
    loadingMore,
    loadMoreError,
    loadMore,
    refetch,
    createConversation,
    deleteConversation,
    renameConversation,
    bumpConversation,
  };
}
