---
type: Fact
title: Unset LLMOXIE_BASE_URL sends traffic to production gateway
description: "lib/ai.ts falls back to LLMOXIE_DEFAULT_BASE_URL, the -prod LiteLLM host on a generated Azure Container Apps name; local and preview runs without LLMOXIE_BASE_URL bill and log against production."
tags: [llm, config, gotcha, llmoxie]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/lib/ai.ts", "apps/web/.dev.vars.example", "apps/web/src/runtime/config.ts"]
sources:
  - resource: "apps/web/src/lib/ai.ts"
  - resource: "apps/web/.dev.vars.example"
---

`getLLMoxie(apiKey, baseURL)` in `apps/web/src/lib/ai.ts` uses `baseURL || LLMOXIE_DEFAULT_BASE_URL`, where the default is `https://llmaven-prod-litellm-prod.lemonmoss-19296c81.westus2.azurecontainerapps.io/v1`. Two consequences:

1. **Dev traffic hits production.** Any local server, preview or eval run with `LLMOXIE_API_KEY` set but `LLMOXIE_BASE_URL` unset (or empty) sends student-shaped traffic, and the `/llm-models` discovery calls, to the production gateway. `.dev.vars.example` deliberately sets a non-resolving placeholder so a copied template fails closed (#348).
2. **The host is fragile.** `lemonmoss-19296c81` is an Azure Container Apps generated environment suffix; recreating that environment changes the hostname. Recovery is a config change (`LLMOXIE_BASE_URL`) rather than a code change, which is why the override exists.

LLMoxie is UW SSEC's LiteLLM proxy and exposes an OpenAI-compatible `/v1` surface, so it uses `createOpenAI` like OpenRouter. Since migration 0035 it is every org's default provider with no per-org credential row, making `LLMOXIE_API_KEY` mandatory. OCR (`OCR_MODEL`, default alias for GPT-5.4 mini) and the instructor "Clean up Markdown" action also go through LLMoxie; the model must be enabled on the gateway (discovery alone does not grant access).

**Rules:**
- Locally, set `LLMOXIE_BASE_URL` to a non-production gateway before running `node:serve` or `tutor:eval -- --mode=live` with `TUTOR_EVAL_PROVIDER=llmoxie`.
- Never hardcode a different default host in code to "fix" this; change configuration.
- In production, `LLMOXIE_BASE_URL` comes from the GitHub `production` environment variable (not a secret) and is validated with the other deployment inputs.
