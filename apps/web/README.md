# llteacher-web

TypeScript / React 19 / Vite / Tailwind 4 / Hono / Cloudflare Workers / Drizzle / Neon port of LLteacher.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the routes-vs-repositories convention and how tenancy scoping is enforced.

## Setup

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and fill in real values.
3. `npm run db:migrate` (after Drizzle schema exists in Phase 1).
4. `npm run dev` to start Vite + Wrangler in dev mode.

## Deploying

`npm run deploy` runs `db:migrate` then `wrangler deploy` -- neither step
provisions secrets, so these must already be set on the target environment
(`wrangler secret put <NAME>`) before the first deploy that needs them:

- `OPENROUTER_API_KEY` -- required from Phase 1 on.
- `LLMOXIE_API_KEY` -- **required as of #178/#317's migration 0035**, not
  optional. Every org's default `llm_configs` row now points at
  `provider = 'llmoxie'` with no instructor-visible credential, so a missing
  binding here is a 500 on every student's every chat turn, in every org --
  not a narrow case that only affects openrouter-only deployments. Declared
  as a required (non-optional) `Env` property in `src/shared/types.ts`
  specifically so `tsc`/`wrangler types` catch its absence before deploy,
  rather than at the first student's first message.
- `LLMOXIE_BASE_URL` -- optional; unset falls back to the gateway's own
  default host (`lib/ai.ts`'s `LLMOXIE_DEFAULT_BASE_URL`).
- `SESSION_SECRET`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, `WORKOS_API_KEY`,
  `WORKOS_WEBHOOK_SECRET` -- see `.dev.vars.example` for what each is for;
  same requirement (must exist on the target before deploy).

## Seeding a dev dataset

```bash
npm run db:seed             # seed once
npm run db:seed -- --reset  # wipe seeded data and re-seed
```

Requires `DATABASE_URL`, `ENCRYPTION_KEY`, and `BLIND_INDEX_KEY` in your shell
env (or `.dev.vars` sourced into it) -- PII fields are encrypted the same way
the app encrypts them at write time.

Seeded accounts (Django parity): `teacher1`/`teacher2` (instructors),
`student1`/`student2`/`student3` (students), all under org `seed-org` /
course `STAT 311`. WorkOS owns login in this stack, so these are **pending**
user rows (`is_pending = true`) — nobody can log in as them directly. They
become claimable on first real WorkOS login whose email's blind index
matches (`teacher1@test.com`, etc.) — see `docs/architecture/multi-tenant-data-model.md`
§3.2 "User identity reconciliation."

## Phase 0 status

Scaffolding only. Auth, LLM, real routes land in subsequent phases (see `../docs/superpowers/plans/`).
