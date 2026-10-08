---
type: Decision
title: Retry-After reports the time left in the rate-limit window
description: "429 responses send the seconds left in the current fixed rate-limit window (retryAfterSeconds, beside reserveRateLimitSlot's bucketing), never the window length, because the client disables Retry for that long."
tags: [rate-limit, retry-after, api, chat]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:53:11Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/server/repositories/rateLimits.ts, apps/web/src/server/routes/chat.ts, apps/web/src/server/routes/conversations.ts, apps/web/src/server/routes/feedback.ts]
sources:
  - resource: "PR #435"
  - resource: "issue #310"
---

## Decision (#310 via PR #435, 2026-10-08)

`reserveRateLimitSlot` buckets requests into fixed windows (`Math.floor(now/windowMs)*windowMs`), so a request refused at 12:00:59.5 is free again at 12:01:00.0. The 429 responses used to send the window LENGTH (60s). Since #286 the client disables its Retry button for exactly `Retry-After` seconds, so the constant locked a working control for up to a minute.

`retryAfterSeconds(now, windowMs)` in `repositories/rateLimits.ts` returns the remaining time, never less than 1 (a refused request must not be told there is nothing to wait for). It lives beside the bucketing so the two cannot drift, and every sender uses it: `routes/chat.ts`, `routes/conversations.ts` (#308) and `routes/feedback.ts`.

## Rule

A new rate-limited route reuses `reserveRateLimitSlot` and `retryAfterSeconds`; it never hand-writes a `Retry-After` value. Route tests mock `retryAfterSeconds` to a fixed value and assert the exact header.

# Related Concepts
- [LLM tutor chat pipeline](../architecture/llm-tutor-pipeline.md): The chat route's 429 path
