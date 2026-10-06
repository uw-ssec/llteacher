---
type: Bug
title: Client-supplied chat history allowed system-message injection
description: "/api/chat validated only the last message; earlier client-sent history went to the model unchanged, so a client could inject a real system message that was never persisted or visible to instructors."
tags: [chat, security, prompt-injection, ai-sdk]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/routes/chat.ts"]
sources:
  - resource: "issue #264"
  - resource: "issue #266"
  - resource: "issue #273"
  - resource: "issue #143"
  - resource: "PR #317"
  - resource: "PR #413"
---

## Root cause (#264, audit of PR #212)

The handler parsed only `uiMessages[uiMessages.length - 1]` with `inboundUserMessageSchema`. It passed the rest of the windowed array through `convertToModelMessages` into `streamText`. The pinned `ai@5` SDK has a real `case "system":` branch, so any element the client marked `role: "system"` became a genuine system message next to the tutor prompt. Those turns were never persisted, so the transcript an instructor reviews showed no trace of the injected instructions. The reviewer confirmed this in the SDK source in `node_modules` rather than assuming it.

## Fixes

- PR #317 (#143) made history **server-authoritative**: the model context is rebuilt from persisted messages, so the client can no longer fabricate turns. It also added per-user rate limits, request-size caps, tenancy binding, a stream timeout and provider-429 mapping.
- PR #413 (#264, #266, #273) validates every element of any history the client still sends. Reusing an `id` with different content returns 409 instead of silently replaying the wrong answer, and concurrent duplicate sends collapse into one model call.

## Rules for future chat work

- Never forward client-supplied message arrays to the model. Build the context from the database for the conversation the caller owns.
- Validate the whole payload, not only the tail. Treat `role` as untrusted.
- Anything that shapes model behaviour must be persisted or auditable, because instructors and FERPA reviews rely on transcripts being complete.
- Related gaps that are still open: a PII-minimization guard on LLM egress (#52), a per-course/global budget (#282) and an adversarial red-teaming harness (#99).
