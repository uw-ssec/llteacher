# llteacher-web

TypeScript / React 19 / Vite / Tailwind 4 / Hono / Node.js / Drizzle / PostgreSQL port of LLteacher.

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
2. Configure the Node process environment. `DATABASE_URL` is required; the
   production secrets are `OPENROUTER_API_KEY`, `LLMOXIE_API_KEY`,
   `SESSION_SECRET`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, `WORKOS_API_KEY`,
   `WORKOS_CLIENT_ID`, and `WORKOS_WEBHOOK_SECRET`. `LLMOXIE_BASE_URL` and
   `LLM_DEGRADED_MODEL` are optional. Load these through your shell, a local
   environment manager, or the container runtime; the app does not parse a
   local environment file itself.
3. `npm run db:migrate`.
4. In one terminal, run `npm run node:serve --workspace=llteacher-web` to
   start the Node API and static server (default port `3000`, or `PORT`).
5. In another terminal at the repository root, run `npm run dev` once. It
   starts the web Vite server on `2311` and the admin Vite server on `2312`.
   Web Vite proxies `/api` to `NODE_API_URL` (default
   `http://localhost:3000`); admin Vite forwards API requests through that
   web proxy.

## Knowledge base runtime

The course knowledge base is an OKF bundle on disk, searched by the pinned `okf` binary.

- Install okf with `brew install okf-memory/tap/okf` and confirm `okf version` prints v0.3.0, the version
  the container image pins and the service's tests run against. If brew installs another version,
  download the `okf-darwin-arm64` asset from the
  [v0.3.0 release](https://github.com/okf-memory/okf-agent-memory/releases/tag/v0.3.0), `chmod +x` it,
  and put it earlier on your `PATH` (or point `OKF_BINARY` at it).
- `mkdir -p .knowledge` and set `KNOWLEDGE_ROOT=$(pwd)/.knowledge` (git-ignored). okf refuses a symlinked
  root, so the app resolves it with realpath; on macOS `/tmp` is a symlink and will not work.
- Uploads go to S3-compatible object storage: `STORAGE_ENDPOINT`, `STORAGE_BUCKET`,
  `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`. For local dev, MinIO works
  (`docker run -d -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data`).
- Scanned PDFs are OCR'd through the LLMoxie gateway with `OCR_MODEL` (optional); page renders need
  `poppler-utils`, which the runtime image installs.
- Production mounts EFS at `/mnt/knowledge` (`KNOWLEDGE_ROOT`) and runs a single task, because a course
  bundle has one writer and okf has no locking beyond the app's own lock file. In-flight extraction jobs
  drain for up to 20 seconds on shutdown, and interrupted ones are marked on the next start.

## Deploying

The ECS task definition supplies the same environment configuration as the
Node process. Set non-secret values in task configuration and inject secrets
through the configured secrets manager before deployment. In particular:

- `OPENROUTER_API_KEY` -- required from Phase 1 on.
- `LLMOXIE_API_KEY` -- **required as of #178/#317's migration 0035**, not
  optional. Every org's default `llm_configs` row now points at
  `provider = 'llmoxie'` with no instructor-visible credential, so a missing
  binding here is a 500 on every student's every chat turn, in every org --
  not a narrow case that only affects openrouter-only deployments. Declared
  as a required (non-optional) `Env` property in `src/shared/types.ts` so
  TypeScript and runtime configuration validation catch its absence before a
  student's first message.
- `LLMOXIE_BASE_URL` -- optional; unset falls back to the gateway's own
  default host (`lib/ai.ts`'s `LLMOXIE_DEFAULT_BASE_URL`).
- `SESSION_SECRET`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, `WORKOS_API_KEY`,
  `WORKOS_WEBHOOK_SECRET` -- all must be set before the service starts.

Deploy in this order: build and publish the image, run `npm run db:migrate`
as a one-off migration task using the new image and production environment,
confirm that migration succeeds, then update the ECS service to the new image.
Do not update the service before its database migration has completed.

The web server does not run the overdue-submission sweep. Schedule it as a
separate one-off ECS task using the same image and environment configuration
as the service.

## Seeding a dev dataset

```bash
npm run db:seed             # seed once
npm run db:seed -- --reset  # wipe seeded data and re-seed
```

Requires `DATABASE_URL`, `ENCRYPTION_KEY`, and `BLIND_INDEX_KEY` in the Node
process environment -- PII fields are encrypted the same way the app encrypts
them at write time.

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

Extraction lifecycle: the Node server recovers interrupted `processing` materials
as `failed` before listening, so instructors can retry them. Queued uploads and
retries share a per-material lock with deletion and reread the current document
path before extracting. This relies on the existing single-process deployment;
overlapping replicas require shared job ownership and coordinated recovery.
Document bodies are written through files under the course lock, avoiding OS
command-argument limits; OKF still maintains the metadata, index, and log.

### Scanned PDF OCR

PDFs without usable embedded text fall back to `gpt-5.4-mini` with low
reasoning effort through `LLMOXIE_BASE_URL` / `LLMOXIE_API_KEY`. Set `OCR_MODEL`
only if the gateway uses a different alias for GPT-5.4 mini. The model must be enabled
on that gateway; discovery alone does not grant access.

Install Poppler locally (`brew install poppler` on macOS, `apt-get install
poppler-utils` on Debian). The runtime Docker image includes it. Pages render
at up to 2400 pixels and are transcribed sequentially, preserving page numbers.
Text-layer PDFs do not make model calls. Scans are limited to 64 pages, each
render to 30 seconds, each model request to 90 seconds, and each document to
20 minutes. Rate limits and server errors receive two bounded retries.

PDF Retry returns 202 and runs through the extraction queue; the console polls
for completion. No partial transcription becomes searchable. Rendering,
model-access, or incomplete-output failures retain the uploaded file and show
a retryable explanation. Generated text identifies the OCR model; equations,
tables, and unclear text should be checked against the original scan.

Set `VITE_ADMIN_URL` in the frontend build environment to the instructor console's
public URL. Staff-only accounts see a teaching workspace link instead of fetching
student homework. Local ports 2311/2312 and 2411/2412 are paired automatically.
Accounts with both staff and student memberships retain access to student homework.

### Instructor Markdown cleanup

The document editor's **Clean up Markdown** action sends the current draft to
GPT-5.4 Mini (low effort) through the configured LLMoxie connection. It proposes
formatting only; it does not save. remark normalizes GFM tables, lists and math.
Instructors review a rendered preview, line diff and fidelity warnings, then
Apply or Discard. Apply uses a saved-body precondition to reject concurrent edits
and runs the normal OKF update/search refresh. Requests time out after two minutes;
documents are limited to 60,000 characters and incomplete output is rejected.

The first body edit preserves the prior body under
`KNOWLEDGE_ROOT/courses/<courseId>/originals/<conceptId>.txt`, outside the searchable
bundle. Include this directory in backups. The editor can restore this original
as a draft and save it. For documents edited before this feature was installed,
the preserved body is the earliest version available at the first subsequent edit,
not necessarily the initial extraction. Deleting a concept removes its preserved
original too.
