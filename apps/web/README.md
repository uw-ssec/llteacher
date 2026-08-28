# llteacher-web

TypeScript / React 19 / Vite / Tailwind 4 / Hono / Cloudflare Workers / Drizzle / Neon port of LLteacher.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the routes-vs-repositories convention and how tenancy scoping is enforced.

## API documentation

`ARCHITECTURE.md` documents *internal* invariants. For the consumer-facing HTTP
contract — request/response shapes, every status code with its literal `error`
string, pagination cursors, and worked `curl` examples — see:

- [`docs/api/conversations.md`](./docs/api/conversations.md) — the conversation
  and chat routes (`/api/conversations*`, `/api/chat`, and the section-conversation
  lifecycle routes under `/api/courses/...`), including the `x-conversation-id`
  header protocol and the per-send `id` idempotency key.

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

`wrangler.jsonc` also registers a Cloudflare Cron Trigger (`"crons": ["17 *
* * *"]`, `wrangler deploy` provisions it automatically) -- the first
scheduled job in this system. It fires the Worker's `scheduled()` export
hourly, at minute 17, to run `autoSubmitOverdueSections` (#167): an
unattended sweep that writes `submissions` rows for section conversations
past their homework's deadline. There is no student or instructor request
behind these writes, so if you're auditing "what can write to `submissions`
outside an HTTP request," this is it.

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
matches (`teacher1@example.com`, etc. — `example.com`, not `test.com`:
WorkOS accepts the IANA-reserved `example.com`/`.org`/`.net` domains
without trying to deliver a real verification email, so AuthKit's
email+password sign-up actually completes; `test.com` has no such
carve-out and gets stuck on an undeliverable verification step) — see
`docs/architecture/multi-tenant-data-model.md` §3.2 "User identity
reconciliation."

## Migrations

Migrations are Drizzle-generated (`npx drizzle-kit generate` from `apps/web`)
into `src/db/migrations/`, applied via `npm run db:migrate`
(`scripts/migrate.ts`).

### Numbering convention — PR-open order (#373)

Drizzle numbers migrations sequentially (`NNNN_description.sql`) off
whatever's on your branch's base at generation time. Two PRs branched from
the same `staging` head will independently generate the *same* next index
-- this isn't a mistake in either PR, it's a collision waiting to surface
at merge time.

**The rule: migration index claims follow PR-open order.** Whichever PR
opened first keeps the index(es) it generated. A PR that opened later and
collides on an index already claimed by an earlier-opened, still-open PR
must renumber its own migrations around it once that earlier PR merges --
regenerate via `drizzle-kit generate` against the now-current `staging`
head (or hand-renumber the file, its `meta/<idx>_snapshot.json`, and its
`meta/_journal.json` entry, keeping the `prevId`/`id` chain intact).

A CI check (`.github/workflows/test.yml`, job `migration-index-collision`)
fails a PR at push time if it introduces a migration file whose `NNNN`
prefix already exists on the PR's base branch under a different filename
-- catching this at open/push time instead of at merge time.

**Precedent:** #317 and #363 collided on `0027`-`0029` first (renumber
merged as `cc73390`). #363 and #366 collided on `0040` next: #363 opened
first and claimed `0040_llm_config_authoring_ta_capability_grading`; #366
opened second, already had three migrations built on the same base
(`0040_cynical_micromax`, `0041_hint_semantics`, `0042_soft_post`), and
renumbered all three around #363's real `0040` once #363 merged --
consolidating into `0041_hint_semantics_and_mark_complete.sql`,
regenerated via `drizzle-kit generate` and verified against the shared dev
Neon DB (llteacher#373; renumber commit on the `worktree-m4-conv-chat-pr3`
branch).

### Hot-table migrations — avoid strong locks (#372)

A plain `CREATE INDEX` takes a `SHARE` lock that blocks writes to the
indexed table for the duration of the build. On `conversations`,
`messages`, and `llm_call_logs` -- written on every chat turn -- that's a
real (if currently small) cost: **`conversations` held 22 rows** as of
#372's audit.

`conversations_course_kind_updated_idx` (`0041_hint_semantics_and_mark_complete.sql`)
is the first real example, not just a written rule: it shipped as a plain
`CREATE INDEX` initially, then was converted to `CREATE INDEX CONCURRENTLY
IF NOT EXISTS` in the same PR once this convention was settled, and
re-verified against the shared dev Neon DB (`scripts/migrate.db.test.ts`'s
"runs a CREATE INDEX CONCURRENTLY statement outside drizzle's batched
transaction" test copies the real migration files, so it re-validates this
specific statement, not a synthetic stand-in).

The same concern isn't limited to index builds.
`0042_steady_slayback.sql` narrows `conversations.updated_at` to millisecond
precision with `ALTER TABLE "conversations" ALTER COLUMN "updated_at" SET
DATA TYPE timestamp (3) with time zone` -- a full table rewrite under an
`ACCESS EXCLUSIVE` lock, strictly heavier than the `SHARE` lock an index
build takes, for the same "written on every chat turn" reason this rule
exists in the first place.

**The rule: any migration on `conversations`, `messages`, or `llm_call_logs`
that would take a lock stronger than what `CREATE INDEX CONCURRENTLY` takes
needs the same scrutiny.** For index migrations specifically, that means
using `CREATE INDEX CONCURRENTLY` with `IF NOT EXISTS` --
`drizzle-kit generate` does not emit `CONCURRENTLY` on its own, so add it by
hand to the generated statement before committing the migration. For other
lock-heavy statements (column type changes, `ALTER TABLE` rewrites, etc.),
there is no `CONCURRENTLY` equivalent -- weigh whether the change can be
done with a lighter-weight technique (e.g. add-column-then-backfill) before
accepting an `ACCESS EXCLUSIVE` lock on one of these tables, and call out the
tradeoff in the migration's PR when you can't avoid it.

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block at all
(a hard Postgres error, not just a lock question), and drizzle's own
migrator batches every pending migration in a folder into one transaction.
`scripts/migrate.ts`'s `applyMigrationsFolder()` handles this: it detects
any `CREATE INDEX CONCURRENTLY` statement in a pending migration, strips
it out before handing the rest of the file to drizzle's `migrate()`, and
runs it separately, directly against the pool, after the rest of the
folder's migrations have committed. This re-runs on every future
`db:migrate` invocation (it doesn't track "already applied" the way
drizzle's own migrations table does) -- harmless *only* because of the
mandatory `IF NOT EXISTS`, which is why that part of the rule isn't
optional.

## Phase 0 status

Scaffolding only. Auth, LLM, real routes land in subsequent phases (see `../docs/superpowers/plans/`).
