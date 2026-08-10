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

  return { conversations, loading, loadError, refetch, createConversation };
}
