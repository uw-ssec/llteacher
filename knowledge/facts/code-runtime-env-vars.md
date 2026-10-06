---
type: Fact
title: Runtime environment variables for the Node API
description: "loadRuntimeConfig requires APP_URL (bare http(s) origin), DATABASE_URL, WORKOS_API_KEY, WORKOS_CLIENT_ID, LLMOXIE_API_KEY, SESSION_SECRET, ENCRYPTION_KEY, BLIND_INDEX_KEY, WORKOS_WEBHOOK_SECRET; the app parses no .env file."
tags: [env, config, secrets, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/runtime/config.ts", "apps/web/src/shared/types.ts", "apps/web/.dev.vars.example", "apps/web/src/lib/ai.ts"]
sources:
  - resource: "apps/web/src/runtime/config.ts"
  - resource: "apps/web/README.md"
  - resource: "apps/web/.dev.vars.example"
  - resource: "infra/README.md"
  - resource: "e017807"
---

`loadRuntimeConfig(process.env)` (apps/web/src/runtime/config.ts) builds the `Env` object passed to Hono as `c.env`. It throws `<NAME> is required` at startup for any missing required value.

**Required:** `APP_URL`, `DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `LLMOXIE_API_KEY`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, `WORKOS_WEBHOOK_SECRET`.

- `APP_URL` must be an absolute http(s) origin with no path, query, hash or credentials (`http://localhost:3000` OK; `http://localhost:3000/` is fine because pathname `/`; anything with a path fails). apps/web/README.md "Setup" omits `APP_URL`; `npm run node:serve` without it fails immediately with `Error: APP_URL is required` (verified). docs/architecture/dev-api-proxy.md lists it correctly.
- `LLMOXIE_API_KEY` is required since migration 0035 made `llmoxie` every org's default provider with no per-org credential; missing it means a 500 on every chat turn in every org.
- Session/encryption keys are 32 random bytes, base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).

**Optional:** `OPENROUTER_API_KEY` (only for OpenRouter-backed configs; optional in production since #468), `LLMOXIE_BASE_URL` (unset falls back to the PRODUCTION LiteLLM host in `lib/ai.ts`; set a non-prod URL locally), `LLM_DEGRADED_MODEL` (opt-in fallback to OpenRouter when the gateway key is missing; no default), `AWS_REGION`, `STORAGE_ENDPOINT`/`STORAGE_BUCKET`/`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` (static keys only for local emulators; AWS uses the task role), `KNOWLEDGE_ROOT`, `OKF_BINARY`, `OCR_MODEL`, `PORT` (default 3000; the image sets 8080), `BUILD_SHA` (reported by `/api/health`).

**Not parsed:** the app does not read `.env` or `apps/web/.dev.vars`. `.dev.vars.example` is a Workers-era template still useful as a checklist; export the variables in the shell or use an env manager. The root `.env` file is for legacy Django.

**Scripts:** `db:migrate` needs only `DATABASE_URL`; `db:seed` needs `DATABASE_URL`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`. Frontend build var: `VITE_ADMIN_URL`. Never put secrets in `VITE_*` variables.
