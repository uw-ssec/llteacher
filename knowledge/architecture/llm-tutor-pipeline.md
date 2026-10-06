---
type: Architecture
title: LLM tutor chat pipeline
description: "POST /api/chat (routes/chat.ts, ~3100 lines) resolves conversation, scope, LLM config and prompt template, assembles the system prompt, runs AI SDK streamText with tools, failover via streamWithFallback, and logs cost to llm_call_logs."
tags: [architecture, llm, chat, ai-sdk, prompts]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:36Z" }
status: stable
governance: context
code_refs: [apps/web/src/server/routes/chat.ts, apps/web/src/lib/prompts.ts, apps/web/src/lib/ai.ts, apps/web/src/lib/llm-config.ts, apps/web/src/lib/context-window.ts, apps/web/src/server/llm/streamWithFallback.ts, apps/web/src/shared/chat-limits.ts, apps/web/docs/api/conversations.md]
sources:
  - resource: apps/web/src/server/routes/chat.ts
  - resource: apps/web/src/server/llm/streamWithFallback.ts
  - resource: apps/web/ARCHITECTURE.md
  - resource: cc47407
---

`chatHandler` (apps/web/src/server/routes/chat.ts) is the hot path and the largest file in the repo (its test file is ~4300 lines). Per turn it:

1. Re-checks `authContext` (fails closed with 401 if called directly), reads the raw body and enforces `MAX_REQUEST_BODY_BYTES` before JSON parse.
2. Reserves a rate-limit slot (`RATE_LIMIT_MAX_PER_MINUTE` = 20/user/min), checks conversation ownership (`getOwnedConversationOrNull`), claims a per-conversation lock, reads history (`MAX_HISTORY_MESSAGES` = 40, then a token budget in `lib/context-window.ts`), inserts the user message (idempotent on client `id`). Tests pin this at ~5 DB round-trips before the model call.
3. Resolves the LLM config (`resolveLLMConfig` in `lib/llm-config.ts`: homework override, then course override, then org default; deactivated rows resolve as absent). Only `openrouter` and `llmoxie` have client factories; other providers raise `UnsupportedLLMProviderError`. Since migration 0035 every org's default provider is `llmoxie` (UW SSEC's LiteLLM gateway) with no per-org credential, so `LLMOXIE_API_KEY` is mandatory. OpenRouter is optional. `LLM_DEGRADED_MODEL` opts into degrading to OpenRouter.
4. Builds the system prompt with `assembleSystemPrompt` (lib/prompts.ts): template -> section content -> knowledge listing -> `TUTOR_GUARDRAIL` (default prompt only) -> tool usage -> mark-complete -> hint instruction -> `VOICE_CONSTRAINTS` (always last). Teacher solutions have no parameter path into the prompt by construction.
5. Calls AI SDK `streamText` with tools `showDefinition`, `executeRCode` (client-side WebR), `requestHint`, `markSectionComplete`, `searchKnowledge`, `showKnowledge`; `stopWhen: stepCountIs(MAX_TURN_STEPS)` (5).
6. `streamWithFallback` probes `fullStream` for the first committing or error chunk; failure before the first content chunk switches to the configured fallback model, after it does not (no half-turn persistence, #268).
7. `finalizeAssistantTurn` persists the assistant message, citations and an `llm_call_logs` cost row.

**Pinned deps:** `ai`, `@ai-sdk/react`, `@ai-sdk/openai` are pinned exactly because chat.ts depends on undocumented internals (`step-start` parts, replay chunk shapes). See facts/code-pinned-ai-sdk-versions.

No per-course spend cap exists; cost is observable via `llm_call_logs` only. The HTTP contract is documented in `apps/web/docs/api/conversations.md`.

# Related Concepts
- [Client-supplied chat history allowed system-message injection](../bugs/client-history-system-message-injection.md): A prompt-injection hole in client history
- [Chat surfaces rebuilt and re-scrolled on every streamed token](../bugs/chat-rerender-per-token.md): A client rendering bug in streaming
