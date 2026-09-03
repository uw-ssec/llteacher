/** #292 (review fix, replacing the original `useChat`-status-based
 *  approach): reads a TEE'D copy of a tutor turn's own SSE response
 *  stream to completion and bumps the rail's message count off THAT,
 *  entirely independent of whichever `useChat` instance the component
 *  happens to have mounted by the time this resolves.
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
 *  Tying the bump to the response stream itself sidesteps the entire
 *  useChat-instance lifecycle: `tutorChatFetch` (App.tsx) tees `res.body`
 *  before handing one half to the SDK, and this function reads the OTHER
 *  half on its own, to completion, regardless of what's mounted or
 *  selected by the time it gets there.
 *
 *  Classification is deliberately conservative rather than an exact
 *  replica of chat.ts's own persistence gate (hasRenderableContent +
 *  TERMINAL_FINISH_REASONS, apps/web/src/server/routes/chat.ts's
 *  `onFinish`): a `finish` chunk with no `error` chunk means the model
 *  produced and completed a real turn -- the overwhelming common case,
 *  matching what that allowlist exists to recognize -- credited as 2 rows
 *  (the student's message, then the reply). Anything else (an `error`
 *  chunk, the stream ending without ever seeing `finish`, or the read
 *  itself throwing -- a dropped connection or an aborted Stop) is
 *  credited as 1: this function only ever runs after `res.ok`, so the
 *  student's own message row was already persisted before the stream
 *  even started (chatHandler's appendMessage runs before it opens the
 *  stream) -- only the reply is in question.
 *
 *  Known gap, left deliberately rather than papered over: a finish reason
 *  chat.ts treats as NOT persist-worthy (e.g. "content-filter") still
 *  reaches the client as an ordinary `finish` chunk in today's protocol,
 *  which this would credit as 2 when the server actually wrote 1.
 *  Closing that precisely needs the server to say authoritatively what it
 *  persisted -- the issue's own alternative ("have /api/chat return the
 *  authoritative count") -- which is server-side surgery out of scope for
 *  this batched client-side-defects task. That finish reason is rare
 *  (a content-filter trip), and reload always shows the true count
 *  regardless, matching the issue's own "a reload silently corrects
 *  both" framing of the ORIGINAL bug -- so this is a narrower, rarer
 *  residual than the bug being fixed, not a reintroduction of it. */
export function trackTutorTurnCompletion(
  conversationId: string,
  stream: ReadableStream<Uint8Array>,
  bumpRef: { current: (id: string, delta: number) => void },
): void {
  void (async () => {
    let sawFinish = false;
    let sawError = false;
    try {
      // Decoded manually (not via `pipeThrough(new TextDecoderStream())`)
      // -- lib.dom's TextDecoderStream is typed as a
      // ReadableWritablePair<string, BufferSource>, and BufferSource is
      // wider than the Uint8Array `pipeThrough` on a
      // ReadableStream<Uint8Array> requires, so TS refuses the pipe even
      // though it's correct at runtime. `{ stream: true }` keeps a
      // multi-byte UTF-8 character that lands across two chunks from
      // being decoded (and silently corrupted) before its second half
      // arrives.
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice("data: ".length);
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload) as { type?: unknown };
              if (chunk.type === "finish") sawFinish = true;
              if (chunk.type === "error") sawError = true;
            } catch {
              /* an unparseable line changes neither flag -- the
                 conservative "no finish observed" classification below
                 already covers it */
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      /* the stream itself errored or was aborted (a dropped connection, a
         client-initiated Stop) -- sawFinish stays false, which is exactly
         the right classification: no confirmed completion. */
    }
    bumpRef.current(conversationId, sawFinish && !sawError ? 2 : 1);
  })();
}
