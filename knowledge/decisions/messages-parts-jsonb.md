---
type: Decision
title: Chat messages store AI SDK UIMessage parts as jsonb instead of a message_type enum
description: "Django's free-text message_type (student/ai/code/code_execution) became a narrow role enum plus a parts jsonb column shaped like the Vercel AI SDK's UIMessage.parts; the doc's role/content_type split was dropped."
tags: [data-model, chat, ai-sdk]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/db/schema/runtime.ts, apps/web/src/server/routes/chat.ts, apps/web/src/server/repositories/conversations.ts, apps/web/package.json]
sources:
  - resource: docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md
  - resource: docs/architecture/multi-tenant-data-model.md
  - resource: apps/web/ARCHITECTURE.md
  - resource: docs/architecture/generative-ui.md
---

## Spec proposed
The port plan (phase 1, Q3) asked whether to port Django's `Message.message_type` as a pg enum or keep it as text. The data-model doc §3.2 proposed refactoring `Message` into `role`, `content_type`, and `agent`, with a backfill.

## Implemented (M2 decision 2)
Neither. `messages.parts` is `jsonb` matching the AI SDK's `UIMessage.parts` (`{type: 'text' | 'tool-call' | ...}[]`), which already carries content type per part. `role` stays a narrow enum (`user | assistant | system`). The seed script deliberately cycles through text, embedded-code, and tool-call/tool-result patterns to show the variety, and does not bring back the old enum (decision 13).

Later work built on this:
- `messages.seq` and `client_message_id` (migration 0023) give strict ordering and idempotent client retries.
- `chat.ts` replays persisted parts by hand-building `UIMessageChunk`s.
- Because of that, `ai`, `@ai-sdk/react`, and `@ai-sdk/openai` are **exact-pinned** (`ai` 5.0.195; #229). `chat.ts` depends on undocumented internals such as the `step-start` part.

## Why
The persisted shape matches the streaming client (`useChat`) and the tool-call model, so there is no translation layer. New tool types (R execution, `searchKnowledge`/`showKnowledge`, generative-UI display tools) need no migration.

## Rejected alternatives
- A pg enum for message type.
- Free text.
- A `role`/`content_type`/`agent` triple.

## Consequences
- Analytics over message kinds must query into jsonb.
- Bumping the AI SDK is a deliberate, reviewed change, not routine maintenance.
- Messages are plaintext at rest (see `decisions/content-encryption-boundary`).

# Related Concepts
- [LLM tutor chat pipeline](../architecture/llm-tutor-pipeline.md): How chat messages are produced and stored
- [Adding NOT NULL columns to messages needs explicit backfill](../facts/code-messages-not-null-backfill.md): Adding NOT NULL columns to messages
- [Truncated or non-replayable assistant turns poison chat idempotency](../bugs/partial-stream-persisted-as-complete.md): A persistence bug in streamed turns
