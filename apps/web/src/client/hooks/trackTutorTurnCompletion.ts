/** #292 (review fix, replacing the original `useChat`-status-based
 *  approach): reads a TEE'D copy of a tutor turn's own SSE response stream
 *  to completion and, once it settles, tells the caller this conversation's
 *  turn is done -- entirely independent of whichever `useChat` instance the
 *  component happens to have mounted by the time this resolves.
 *
 *  Why the original status-based version was wrong: `@ai-sdk/react`'s
 *  `useChat` recreates a brand-new `Chat` instance whenever `id` changes
 *  (`shouldRecreateChat` in its own use-chat.ts), and a freshly
 *  constructed instance's status defaults to "ready" -- it was never
 *  submitted or streaming. So switching away from conversation A
 *  mid-stream (selecting row B) swaps `tutorConversationId`, which
 *  recreates the Chat instance, which reports "ready" on its very next
 *  render -- a transition that LOOKS identical, from the
 *  wasInFlight-then-"ready" effect's point of view, to A's turn actually
 *  completing. It hadn't: nothing aborts or forwards A's real completion
 *  once the component stops subscribing to it (confirmed against
 *  @ai-sdk/react's own subscribeToMessages, keyed on `chatRef.current.id`
 *  -- once `id` changes, A's own eventual status changes are never
 *  observed by this component again). Every mid-stream conversation
 *  switch was therefore credited as an immediate, full +2 for whichever
 *  conversation was being switched AWAY FROM -- the literal scenario
 *  #292 reports, still present after the first version of this fix (which
 *  only corrected WHICH conversation gets credited, not WHEN).
 *
 *  Tying completion to the response stream itself sidesteps the entire
 *  useChat-instance lifecycle: `tutorChatFetch` (App.tsx) tees `res.body`
 *  before handing one half to the SDK, and this function reads the OTHER
 *  half on its own, to completion, regardless of what's mounted or
 *  selected by the time it gets there.
 *
 *  #438: this used to also CLASSIFY the turn from the stream's own SSE
 *  chunks (a `finish` chunk with no `error` chunk -> credit +2, anything
 *  else -> credit +1) and hand that guessed delta to the rail. That was
 *  deliberately conservative, not exact: chat.ts's real persistence gate is
 *  `hasRenderableContent` plus a finish-reason allowlist, and a turn whose
 *  finish reason isn't on that allowlist (e.g. "content-filter") still
 *  reaches the client as an ordinary-looking `finish` chunk in today's
 *  protocol -- credited as +2 here when the server actually wrote only the
 *  student's row. The client cannot tell those two cases apart from the
 *  stream alone, which is exactly why guessing was the wrong shape for this
 *  function: it can only ever narrow the odds of being wrong, never close
 *  them.
 *
 *  So this no longer inspects the stream's content at all -- it only reads
 *  the tee'd half to completion (success, an in-stream `error` chunk, a
 *  dropped connection, or an aborted Stop all end the same way: the read
 *  loop stops, one way or another) and then asks the CALLER to reconcile
 *  against the server's own authoritative count
 *  (useTutorConversations.ts's `reconcileConversationCount`, via
 *  `GET /api/conversations/:id`) instead of asserting a number the client
 *  computed itself. This function only ever runs after `res.ok` (see
 *  tutorChatFetch, App.tsx), so the student's own message row was already
 *  persisted before the stream even started (chatHandler's appendMessage
 *  runs before it opens the stream) -- reconciling is always safe to call
 *  here, whatever happened to the reply. */
export function trackTutorTurnCompletion(
  conversationId: string,
  stream: ReadableStream<Uint8Array>,
  reconcileRef: { current: (id: string) => void },
): void {
  void (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* The stream itself errored or was aborted (a dropped connection, a
         client-initiated Stop) -- nothing to classify: whatever the server
         did or didn't persist before that happened is already final by the
         time this catches, and the reconciliation call below asks it
         directly rather than guessing from here. */
    } finally {
      reader.releaseLock();
    }
    reconcileRef.current(conversationId);
  })();
}
