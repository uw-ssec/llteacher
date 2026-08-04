# llteacher-web

TypeScript / React 19 / Vite / Tailwind 4 / Hono / Cloudflare Workers / Drizzle / Neon port of LLteacher.

## Setup

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and fill in real values.
3. `npm run db:migrate` (after Drizzle schema exists in Phase 1).
4. `npm run dev` to start Vite + Wrangler in dev mode.

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
