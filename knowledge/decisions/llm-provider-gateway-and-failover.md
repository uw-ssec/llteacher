---
type: Decision
title: "LLM calls go through the Vercel AI SDK to OpenAI-compatible providers, with LLMoxie as the platform default"
description: "Each LLM config names a provider (llmoxie or openrouter) built via @ai-sdk/openai; migration 0035 made SSEC's LiteLLM gateway LLMoxie every org's default, with documented degradation to OpenRouter and pre-first-token failover."
tags: [llm, providers, reliability, configuration]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/lib/ai.ts, apps/web/src/lib/llm-config.ts, apps/web/src/server/llm/streamWithFallback.ts, apps/web/src/server/routes/chat.ts, apps/web/src/db/migrations/0035_llmoxie_default_config.sql, apps/web/src/server/routes/llmConfigs.ts]
sources:
  - resource: docs/superpowers/plans/2026-06-01-llteacher-fullstack-port.md
  - resource: docs/superpowers/plans/2026-06-01-llteacher-platform-generalization.md
  - resource: docs/superpowers/plans/2026-08-07-m4-conversations-chat-parity.md
  - resource: docs/architecture/generative-ui.md
  - resource: commit e017807
  - resource: commit 073d785
  - resource: commit ac34e17
  - resource: "PR #317"
  - resource: "PR #333"
  - resource: "PR #363"
  - resource: "issue #332"
  - resource: "issue #107"
  - resource: "issue #365"
  - resource: "PR #382"
  - resource: "PR #412"
  - resource: "PR #468"
  - resource: "issue #390"
  - resource: "issue #282"
---

## Spec proposed
Both June plans chose **OpenRouter** as the multi-provider router so each course could pick any model. The port plan specified the Vercel AI SDK with `streamText` and `useChat`. The generalization plan's per-org enterprise credentials and HIPAA/BAA concerns pointed toward per-org provider keys.

## Implemented
- `lib/ai.ts` builds providers with `createOpenAI`: `getOpenRouter`, and `getLLMoxie` for UW SSEC's LiteLLM gateway (#178). The base URL can be overridden with `LLMOXIE_BASE_URL`.
- `lib/llm-config.ts` resolves the config → provider → credential, using `organization_credentials.secretRef` allowlisted env bindings or the env fallbacks `OPENROUTER_API_KEY` / `LLMOXIE_API_KEY`.
- `PLATFORM_DEFAULT_PROVIDER = "llmoxie"`. Migration 0035 made LLMoxie every org's default.
- `PROVIDER_DEGRADATION` maps llmoxie → openrouter when the gateway key is missing (#343/#412/#431).
- `server/llm/streamWithFallback.ts` adds one level of instructor-configured failover. It applies **only before the first content chunk**. After that, mid-stream errors are not retried, because a retry would duplicate or discard text the student already saw (#98/#364).
- In production, `OPENROUTER_API_KEY` became optional (commit `e017807`). The M5 console (commit `ac34e17`) provides LLM-config CRUD, and the connection test uses the config's own provider (`073d785`).

## Why
LLMoxie is SSEC-operated and OpenAI-compatible, which keeps student traffic on a UW-affiliated gateway (inferred). OpenRouter is still the fallback and the broad model catalogue.

## Rejected alternatives
- Calling the OpenAI SDK directly with a `base_url` in Django (generalization phase 1; never landed).
- Re-running a turn mid-stream on the fallback model.

## Consequences
- Removing `LLMOXIE_API_KEY` without OpenRouter configured leaves chat with no working provider.
- `secretRef` must stay allowlisted. `llm-config.ts` warns that a ref like `ENCRYPTION_KEY` would send a PII key to a provider.

## From the issue tracker and reviews

## Resolution

- PR #317 (#26) replaced the hardcoded model with **org default, then homework override** resolution. #178 wired in the LLMoxie key and LiteLLM provider dispatch. PR #333 added a configurable gateway host and a model discovery endpoint.
- PR #363 (M5) added LLM config CRUD with **single-default enforcement** per org, cloning, a documented resolution order, and a fallback model on provider failure (#98).
- `PROVIDER_FALLBACK_ENV_VAR` maps `llmoxie` to `LLMOXIE_API_KEY`. A config row with `provider: "llmoxie"` and `credential_id = NULL` resolves the **platform key** with no instructor involvement.

## Planned two tiers (#332, #107; open)

1. **Platform gateway (default):** instructors choose LLMoxie and a model from the catalogue. They never see or supply the credential.
2. **Instructor-owned providers:** a named provider with the instructor's own key. This depends on the credential write path, which is why #323's secret-ref allowlist mattered.

This fits the CDI model in which each project pays for its own inference from grants.

## Pitfalls found

- **#365 (fixed, PR #382):** `testLlmConfigHandler` hardcoded `getOpenRouter()` and `OPENROUTER_API_KEY`. Pressing Test on an LLMoxie default sent that model to OpenRouter with the wrong credential. Rule: every call path must use `buildProviderClient` plus `resolveApiKey`, exactly as `chat.ts` does. A test (PR #444) keeps the resolvers aligned.
- **#390 (open):** the test handler builds the provider from one config read and the request from another.
- PR #468 made OpenRouter optional in production. Open PR #412 (degrade to OpenRouter when the gateway key is missing) predates that and may be obsolete (inferred).
- **Budgets:** the only throttle is a per-user rate limit (20/min). The scarce resource is a shared credential, so per-course and global budgets are needed (#282) and per-student quotas are planned (#77). At about 30 concurrent students on one free-tier key, every turn failed in the analysis.

## Authority gap

LLM configs are an **org-level pool** edited through a **course-level** guard (see facts/authority-and-provisioning-gaps, #367).

# Related Concepts
- [LLM tutor chat pipeline](../architecture/llm-tutor-pipeline.md): Provider calls in the tutor pipeline
- [Unset LLMOXIE_BASE_URL sends traffic to production gateway](../facts/code-llmoxie-default-base-url-is-prod.md): Unset base URL falls back to production
- [AI SDK packages are pinned to exact versions](../facts/code-pinned-ai-sdk-versions.md): AI SDK versions are pinned exactly
- [Runtime environment variables for the Node API](../facts/code-runtime-env-vars.md): Environment variables that configure providers
