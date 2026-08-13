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
  /** True only when a fetch to a *known* courseId failed (network error or
   *  non-2xx) -- never true just because courseId hasn't loaded yet. */
  loadError: boolean;
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

  const refetch = useCallback(() => {
    if (!courseId) {
      // Not a fetch error -- there's simply no course to scope the query
      // to yet (homework list still loading, or the student has none).
      setConversations([]);
      setLoadError(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/conversations?courseId=${encodeURIComponent(courseId)}&kind=tutor`)
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load tutor conversations: ${r.status}`);
        return r.json() as Promise<ConversationListResponse>;
      })
      .then((data) => {
        // #281: the route now returns { items, nextCursor } instead of a
        // bare array. Only `items` is consumed here -- this hook doesn't
        // paginate yet (wiring `nextCursor` into an actual load-more is
        // #280's job); a single initial fetch is still exactly what every
        // caller of `refetch` wants today.
        setConversations(data.items);
        setLoadError(false);
      })
      .catch(() => {
        setConversations([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, [courseId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

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
        setConversations((prev) => [withCount, ...prev]);
        return withCount;
      } catch {
        return null;
      }
    },
    [courseId],
  );

  const renameConversation = useCallback(async (id: string, title: string): Promise<ConversationListItemResponse> => {
    const previousRow = conversationsRef.current.find((c) => c.id === id);

    // Optimistic update -- applied synchronously, before the PATCH even
    // goes out.
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
    setConversations((prev) => {
      const now = new Date().toISOString();
      const next = prev.map((c) => (c.id === id ? { ...c, messageCount: c.messageCount + 1, updatedAt: now } : c));
      // Matches listConversationsForOwner's desc(updatedAt) server-side
      // ordering -- without this, the bumped row's count/timestamp update
      // but it stays in its old list position until the next full refetch.
      return next.slice().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    });
  }, []);

  return { conversations, loading, loadError, refetch, createConversation, renameConversation, bumpConversation };
}
