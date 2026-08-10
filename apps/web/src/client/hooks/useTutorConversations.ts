import { useCallback, useEffect, useState } from "react";
import type { ConversationListItemResponse, ConversationSummary } from "../../shared/types";

/* --------------------------------------------------------------------------
   useTutorConversations — fetches and manages a student's course-scoped
   "tutor" conversations (#4).

   Mirrors useStudentHomework's fetch-on-mount + explicit loadError shape
   (App.tsx) rather than throwing inside a .then chain on a non-ok response
   (#160 fixed exactly that class of bug for the sibling hook) -- a 401/403
   here must be distinguishable from "loaded, genuinely zero conversations."

   `courseId` is expected to come from the already-fetched homework summary
   (StudentHomeworkSummary.courseId) -- the client has no other source of
   course context today (see that field's doc comment). Passing `undefined`
   is a valid "not loaded yet" state: the hook reports an empty list,
   loading: false, and skips the fetch/create network calls entirely rather
   than requesting with a malformed courseId.
   -------------------------------------------------------------------------- */

export interface UseTutorConversationsResult {
  conversations: ConversationListItemResponse[];
  loading: boolean;
  /** True only when a fetch to a *known* courseId failed (network error or
   *  non-2xx) -- never true just because courseId hasn't loaded yet. */
  loadError: boolean;
  /** Refetches the list from the server. Not called automatically after
   *  createConversation (that appends optimistically instead, per the
   *  issue's pitfall #2: "toggle should not trigger a re-fetch"). */
  refetch: () => void;
  /** POSTs a new tutor conversation and prepends it to the local list.
   *  Returns the created conversation, or null if courseId isn't loaded
   *  yet or the request failed -- callers should treat null as "nothing to
   *  select," not throw. */
  createConversation: (title?: string) => Promise<ConversationListItemResponse | null>;
  /** #6: PATCHes a conversation's title, optimistically updating the local
   *  list immediately (so both the list row AND any other consumer reading
   *  from this same `conversations` array, e.g. App.tsx's tutor chat
   *  header, reflect the new title without waiting on the network).
   *  Reconciles with the server's response on success. On failure, the
   *  optimistic update is rolled back to whatever this row's title was
   *  before the call, and the returned promise REJECTS (unlike
   *  createConversation's fails-open-with-null convention) -- this is a
   *  deliberate difference: EditableTitle (the caller, via
   *  ConversationListItem/App.tsx) needs a rejection to know to show its
   *  own inline error and revert its displayed value, matching the issue's
   *  "on failure, revert and show inline error" requirement -- a null
   *  return would look identical to "saved successfully with no change." */
  renameConversation: (id: string, title: string) => Promise<ConversationListItemResponse>;
}

export function useTutorConversations(courseId: string | undefined): UseTutorConversationsResult {
  const [conversations, setConversations] = useState<ConversationListItemResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

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
        return r.json() as Promise<ConversationListItemResponse[]>;
      })
      .then((data) => {
        setConversations(data);
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
        // messages, so it's filled in as 0 rather than left undefined (see
        // ConversationListItemResponse's doc comment above).
        const created = (await res.json()) as ConversationSummary;
        const withCount: ConversationListItemResponse = { ...created, messageCount: 0 };
        // Prepended, not re-fetched: matches listConversationsForOwner's
        // desc(updatedAt) ordering (a brand-new conversation is always the
        // most recently updated) without a round-trip the issue's pitfall
        // #2 says isn't warranted here.
        setConversations((prev) => [withCount, ...prev]);
        return withCount;
      } catch {
        return null;
      }
    },
    [courseId],
  );

  const renameConversation = useCallback(
    async (id: string, title: string): Promise<ConversationListItemResponse> => {
      // Read from the closure BEFORE the optimistic update below, rather
      // than capturing it from inside setConversations's updater function:
      // React does not guarantee that updater is invoked synchronously
      // (it's only guaranteed to run before the next render that reads the
      // resulting state), so a `let previousRow` assigned inside the
      // updater was observed to still be `undefined` here by the time the
      // PATCH response was reconciled below. This closure read is exactly
      // as current as the last commit `conversations` came from, which is
      // enough for a value the student just saw on screen a moment ago.
      const previousRow = conversations.find((c) => c.id === id);

      // Optimistic update -- applied synchronously, before the PATCH even
      // goes out, per the issue's "title updates in UI immediately"
      // requirement.
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));

      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!res.ok) {
          // Prefer the server's own message (updateConversationHandler's
          // "title is required and must be 1-100 chars after trimming",
          // or a 404 "Conversation not found") over a generic status code
          // -- it's what EditableTitle will show inline.
          let message = `failed to rename conversation: ${res.status}`;
          try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) message = body.error;
          } catch {
            /* non-JSON error body -- fall back to the generic message */
          }
          throw new Error(message);
        }
        // PATCH's response is a plain ConversationSummary, same shape as
        // POST's (see createConversation above) -- messageCount isn't in
        // it, so it's carried forward from the row being renamed rather
        // than defaulted to 0 (unlike a brand-new conversation, this row
        // may well have messages already).
        const updated = (await res.json()) as ConversationSummary;
        const withCount: ConversationListItemResponse = {
          ...updated,
          messageCount: previousRow?.messageCount ?? 0,
        };
        setConversations((prev) => prev.map((c) => (c.id === id ? withCount : c)));
        return withCount;
      } catch (err) {
        // Roll back the optimistic update -- this row goes back to
        // whatever it was before this call, not the failed attempt.
        setConversations((prev) => prev.map((c) => (c.id === id && previousRow ? previousRow : c)));
        throw err instanceof Error ? err : new Error("failed to rename conversation");
      }
    },
    [conversations],
  );

  return { conversations, loading, loadError, refetch, createConversation, renameConversation };
}
