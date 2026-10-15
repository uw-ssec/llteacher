---
type: Bug
title: Truncated or non-replayable assistant turns poison chat idempotency
description: "A stream that errored after some text was persisted as a complete answer and replayed forever; a related fallthrough returned 409 in_progress for already-finished turns, so retries never recovered."
tags: [chat, streaming, idempotency, reliability]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T18:32:26Z" }
status: stable
governance: context
code_refs: [apps/web/src/server/routes/chat.ts]
sources:
  - resource: "issue #268"
  - resource: "issue #433"
  - resource: "issue #426"
  - resource: "PR #413"
  - resource: "PR #436"
---

## Context

`/api/chat` makes turns idempotent through a `clientMessageId`. If the user message is already stored, the handler re-reads the last rows and classifies the turn. A `replay` turn returns the stored assistant answer without calling the model again.

## Bug 1: partial answers stored as complete (#268, fixed in PR #413)

`hasRenderableContent` rejected an *empty* assistant turn but accepted a *partial* one. A provider error or client disconnect mid-generation emits `text-delta`, then `error`, then `finish(reason=error)`. `onFinish` still ran and saved a row whose text part had `state: "streaming"`. A retry with the same `clientMessageId` then hit the replay path and got the truncated answer back **forever**. The team reproduced this against the real `streamText` / `toUIMessageStreamResponse` pipeline rather than inferring it. Fix: a turn that errors or aborts is never persisted as complete.

## Bug 2: 409 in_progress for a finished turn (#433, fixed in 0c9a9f9)

After deduplication, any classification other than `replay` fell through to `409 in_progress`. That assumed the only reason was a concurrent turn still running. A turn whose stored assistant row is simply not replayable (for example a `requestHint`-only turn after the #307/#342 tightening, issue #426) also lands there. The client renders 409 as retryable, so the student retries into the same 409 forever. Fixed on `staging` by commit 0c9a9f9, which closed #433 on 2026-09-10. When the second-to-last row is the inbound `clientMessageId` and the last row is an assistant reply, `turnAlreadyCompleted` makes a real model call instead of answering 409. The lock stays held on that path, and `persistedHistory` is re-read rather than taken from the pre-race snapshot. Tests: `chat.test.ts`, "#433 completed-but-non-replayable turn is not a genuine race". PR #436 proposed the same fix and was closed as superseded on 2026-10-08.

## Lessons

- Idempotency caches must only store terminal-success results. Check the finish reason, not just whether content is present.
- A catch-all error branch should not claim a specific cause like "in progress" unless it has checked that cause. Several sibling bugs (#236, #241, #242, #251: infrastructure failures reported as 404) come from the same pattern.
- Related open item: #335. A hung stream that never sends a chunk has no timeout and no stopped-state UI.
