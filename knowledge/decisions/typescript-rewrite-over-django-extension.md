---
type: Decision
title: Rewrite in TypeScript instead of extending the Django app
description: "Two competing 2026-06-01 plans: extend Django in place, or port to a TS/React/Hono stack. The port won; the Django OpenRouter phase never landed and Django stays only as legacy until cutover."
tags: [architecture, port, django, typescript]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: context
code_refs: [apps/web, apps/admin, packages/ui, apps/llm/src/llm/models.py, package.json]
sources:
  - resource: docs/superpowers/plans/2026-06-01-llteacher-fullstack-port.md
  - resource: docs/superpowers/plans/2026-06-01-llteacher-platform-generalization.md
  - resource: "PR #106"
  - resource: commit a7cf2c3
---

## Spec proposed
Two master plans were written on 2026-06-01. The **platform-generalization** plan kept Django 5.2 + Bootstrap and extended it along six axes: OpenRouter `base_url`, a pluggable `AgentRuntime`, multi-tenancy, RAG with pgvector, Canvas LTI 1.3, and UW FERPA/HIPAA hosting. It pushed a TS/React rewrite to a winter follow-on. The **fullstack-port** plan replaced Django with React 19 + Vite + Tailwind 4 and a Hono API, using Drizzle + Neon, WorkOS, and the Vercel AI SDK. It aimed for Django parity first and platform features afterwards. Its phases 1-11 were scope-only, and each had to be re-planned before work began.

## Implemented
The port won. Commit `a7cf2c3` (PR #106, 2026-07-30) bootstrapped the TS monorepo, and all M1-M12 work landed there. Phase 1 of the generalization plan (a Django `LLMConfig.base_url` field plus migration `0003`) **never landed**. `apps/llm/src/llm/models.py` has no `base_url`, and the Django migrations stop at `0002`. The legacy Django code (`apps/{accounts,conversations,homeworks,llm}`, `src/`, `services/`) is still in the repo. The root `package.json` describes it as legacy that stays "until cutover".

## Why (inferred from the plans and the history)
The port plan treats the rewrite as a chance to fix structural problems before adding tenants. The legacy executive summary names nullable conversation FKs, a global `LLMConfig`, and no tenancy or audit as data-model problems. Platform features slot in after parity.

## Rejected alternatives
- Incrementally generalizing Django (the generalization plan as written).
- Convex as the data layer (rejected in the port plan as duplicating a SQL ORM).
- React Server Components and AG-UI/A2UI protocols in v1.

## Consequences
- The generalization plan's six axes survive as *product requirements*, but they are carried out in TS: tenancy (M1/M2), RAG (M7), Canvas (M11), and hosting (M12). The Django-specific steps are obsolete.
- The port plan's Cloudflare Workers + Neon target was itself later replaced by AWS. See `decisions/aws-ecs-fargate-runtime`.
- Data migration from Sara's live SQLite deployment and Django retirement (port phases 10-11) are still not done.

# Related Concepts
- [Legacy Django app and its relation to the TS port](../architecture/legacy-django.md): The legacy app the rewrite replaces
- [The TS port must reach Django feature parity first, and deviations must be written down](../requirements/django-parity-baseline.md): Parity with Django is the bar the rewrite must meet
- [Turborepo with a student SPA, an instructor SPA, and one shared Hono API](monorepo-two-spas-one-hono-api.md): Shape of the rewrite
