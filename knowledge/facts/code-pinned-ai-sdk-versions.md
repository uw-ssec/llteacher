---
type: Fact
title: AI SDK packages are pinned to exact versions
description: "ai@5.0.195, @ai-sdk/react@2.0.197 and @ai-sdk/openai@2.0.106 are pinned exactly (also in evals) because chat.ts and streamWithFallback rely on undocumented internals; any bump is a reviewed change."
tags: [dependencies, ai-sdk, llm, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/package.json", "evals/package.json", "apps/web/src/server/routes/chat.ts", "apps/web/src/server/llm/streamWithFallback.ts", "apps/web/src/server/routes/chat.errorChunk.integration.test.ts", "apps/web/src/server/routes/chat.fallback.integration.test.ts"]
sources:
  - resource: "apps/web/ARCHITECTURE.md"
  - resource: "apps/web/src/server/llm/streamWithFallback.ts"
  - resource: "apps/web/package.json"
---

`apps/web/package.json` pins `"ai": "5.0.195"`, `"@ai-sdk/react": "2.0.197"`, `"@ai-sdk/openai": "2.0.106"` with no `^` (#229). `evals/package.json` also pins `ai` to `5.0.195`. Keep them in lockstep.

**Why:**
- `routes/chat.ts` depends on the SDK's step machinery always pushing a `{ type: "step-start" }` part onto `responseMessage.parts` (see `hasRenderableContent`) and on exact `UIMessageChunk` shapes that `replayPersistedPart` hand-constructs to impersonate a `streamText` response on the idempotency-replay path.
- `server/llm/streamWithFallback.ts` documents that in 5.0.195 `result.response` only settles after the LAST chunk (it is `finalStep.then(...)`), and that provider failures arrive as an `error` chunk on a stream that closes normally rather than a rejection. Awaiting `result.response` would make time-to-first-token equal to full-turn latency. The failover probe therefore reads the tee'd `fullStream` until the first committing or error chunk. A different SDK version can silently invalidate both claims.

**Coverage:** `chat.errorChunk.integration.test.ts` drives a real `streamText()` against an erroring model and catches a `step-start` regression; `chat.fallback.integration.test.ts` covers failover. Replay-chunk shapes have thinner coverage.

**Rules:**
- Do not let `npm install`/dependabot float these. Treat a bump as its own PR: read the SDK changelog, re-verify the `response`/`steps` semantics noted in streamWithFallback.ts, run the full `apps/web` suite and the integration tests, and update the version numbers quoted in comments.
- LLM providers are reached through `createOpenAI` with a custom `baseURL` (`getOpenRouter`, `getLLMoxie` in `lib/ai.ts`). No provider-specific SDKs.
