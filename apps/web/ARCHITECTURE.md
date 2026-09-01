# apps/web Architecture Notes

## Routes and Repositories

`apps/web/src/server/routes/*.ts` must never import `db.select`/`db.insert`/table
objects from `../../db/schema`, or `drizzle-orm` query helpers (`eq`, `and`,
...) directly. Data access goes through `apps/web/src/server/repositories/`.

Why: the repository layer is where org/course tenancy scoping is enforced
(`OrgScope`/`CourseScope` branded types in `repositories/scope.ts` --
see `docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md`). A route
that queries Drizzle directly bypasses that guard silently -- it will
typecheck and run, it just won't be scoped.

A route handler's shape is: resolve a `Db` via `makeDb(c.env.DATABASE_URL)`,
resolve a scope from `AuthContext` (`orgScope(...)` / `courseScope(...)`),
call one or more repository functions, shape the response. No `.from(...)`,
`.where(...)`, or `.values(...)` calls in route files.

Enforcement today is code-review convention, not a lint rule. Revisit if
violations recur.

### Scheduled jobs are the second caller of that layer (#167)

`apps/web/src/server/jobs/*.ts` holds work triggered by a Cloudflare Cron
Trigger (`triggers.crons` in `wrangler.jsonc` -> the Worker's `scheduled()`
export in `server/index.ts`) rather than by a request. The same rule
applies, for a stronger reason: a job has no authenticated caller, so
there is no `AuthContext` membership that would have narrowed a forgotten
`WHERE` clause by accident. A job resolves a `Db`, obtains scopes, calls
repository functions, and does nothing else — orchestration, counting,
logging.

A platform-wide job still never issues a platform-wide *query*. The one
unscoped read it may perform is enumerating tenants
(`listAllOrgScopes`, `repositories/organizations.ts`), which returns
`OrgScope`s rather than raw ids so that everything downstream of it is
per-tenant by construction. See `jobs/autoSubmitOverdue.ts`.

## Tenancy Enforcement

Shared-schema multi-tenancy (one Postgres schema, every tenant's rows
side-by-side) needs a guard that makes "forgot the WHERE clause" hard, not
just discouraged. Two mechanisms combine to do that:

1. **A denormalized `organization_id` (or `course_id`) column on every
   runtime leaf table.** `submissions`, `grades`, `citations`,
   `llm_call_logs`, `student_profiles`, and `audit_events` all carry
   `organizationId`; `conversations`, `messages`, `homeworks`, `sections`,
   and `courseMaterials` carry (or inherit) `courseId`. This is redundant
   with what's reachable via FK joins, but it means a query can filter the
   tenancy boundary directly on the table being queried, with an index on
   it, instead of joining up a chain of FKs correctly every time.
2. **Branded scope types at the repository boundary**
   (`apps/web/src/server/repositories/scope.ts`): `OrgScope` and
   `CourseScope` are plain `string`s at runtime, but TypeScript treats them
   as distinct types from a raw `string` and from each other. Every
   repository function takes one as a parameter; passing a bare string
   where a scope is expected is a compile-time type error, not a runtime
   surprise. `orgScope(id)` / `courseScope(id)` are the only ways to
   produce one -- construct them from a value already verified to belong
   to the caller (an `AuthContext` membership, or a row just read back from
   the DB), never from unvalidated request input.

Together: the schema makes tenancy-scoped queries *possible* without a
join; the branded types make writing an *unscoped* query a type error. See
[docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md](../../docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md)
for the full reasoning, including which tables use which scope and why.

## Row Ownership (Within a Scope)

`OrgScope`/`CourseScope` answer "does this row belong to the caller's
org/course" -- they do not answer "may *this specific caller* touch *this
specific row*." `repositories/conversations.ts`'s `softDeleteConversation`
and `appendMessage` enforce `CourseScope` only: neither function checks the
row's `ownerUserId` against the caller itself, so calling either directly
with just a `CourseScope` would let any member of the course touch any other
student's conversation by UUID.

**#301 update:** this is no longer a latent gap -- both functions are now
route-reachable (`DELETE /api/conversations/:id` -> `deleteConversationHandler`
-> `softDeleteConversation`; every `/api/chat` turn -> `chatHandler` ->
`appendMessage`), and the doc below previously said "no M3 route calls
either function today," which stopped being true the moment those routes
shipped. **Current reality:** ownership is enforced *at the route layer*,
one tier up from where this section originally proposed adding it.
`deleteConversationHandler` calls `getOwnedConversationOrNull`
(`repositories/conversations.ts` -- see "Tenancy Mismatch Errors" below for
why it moved out of `routes/conversations.ts`) first, and only calls
`softDeleteConversation` with a `CourseScope` minted from that
already-ownership-checked row; `chatHandler` does the identical
existing-conversation check before its own `appendMessage` calls. Neither
repository function grew the `requesterId` parameter this section originally
proposed -- the route-layer check made it unnecessary for the callers that
exist today.

**Rule for the next conversation-mutating route:** call
`getOwnedConversationOrNull` (or, for a route inside an already-scoped
create/list flow, an equivalent ownership check) *before* calling
`softDeleteConversation`, `appendMessage`, `updateConversationTitle`, or any
future conversation-mutating repository function. These functions will
silently accept a call from a caller who isn't the row's owner if you skip
this -- they were never given their own ownership check, and #134 (below)
is why that was a deliberate choice, not an oversight to route around.

**#134 still open:** the belt-and-braces alternative this section
originally proposed -- growing an explicit `requesterId` parameter on the
repository functions themselves, so the ownership check runs in the same
query that already fetches the row instead of as a separate read-then-check
-- remains unimplemented. Every current caller happens to check ownership
first, so there is no live exploit, but a future route that forgets the
rule above has nothing at the repository layer to catch it. Revisit if a
second conversation-mutating surface (an admin/instructor override path, for
instance) makes "the route always checks first" harder to guarantee by
inspection alone.

## Tenancy Mismatch Errors

A repository function's `CourseScope` check (see "Tenancy Enforcement"
above) can fail two different ways: an unexpected infra failure (DB
connection drop, etc.), or an expected condition -- the caller passed an id
(an owner, a section, a conversation) that just doesn't belong to the scope
it's being used under. Prior to [#141](https://github.com/uw-ssec/llteacher/issues/141)
every repository function threw a plain `Error` for both cases, which meant
neither the route layer nor `app.onError` (`server/index.ts`) could tell
them apart -- a tenancy mismatch fell through to the same generic 503 a
real DB outage gets, when the honest response is a 404 (mirroring the
404-not-403 convention `getOwnedConversationOrNull`
(`repositories/conversations.ts` -- moved there from `routes/conversations.ts`
so `chatHandler`'s conversationId ownership check, #217, could reuse the
identical rule instead of hand-rolling its own) already established for the
route-level ownership check: never leak whether a row exists via the status
code).

**Convention:** a repository function that detects this specific condition
throws `TenancyMismatchError` (`repositories/errors.ts`) instead of a plain
`Error`. `server/index.ts`'s `app.onError` -- already the single place
every uncaught error in the app funnels through -- checks
`err instanceof TenancyMismatchError` first and maps it to a 404, before
falling through to the generic 503 for everything else. This is a shared
app-layer handler, not a per-route `try`/`catch`: any repository function
that wants this behavior throws the same class, and every route gets the
mapping for free without its own catch block.

As of #141, `createConversation`/`appendMessage`
(`repositories/conversations.ts`) throw it. `recordGrade`
(`repositories/submissions.ts`) is expected to reuse it when
[#75](https://github.com/uw-ssec/llteacher/issues/75) (M5) wires a route to
it. `createSubmission` (`repositories/submissions.ts`) deliberately does
**not** use this: [#22](https://github.com/uw-ssec/llteacher/issues/22)'s
`submitSectionHandler` already has its own reasoned (403, not 404)
convention for that call site (mapping both "doesn't exist" and "wrong
owner" to a uniform 403, so a non-owner can't use a 404-vs-403 split to
learn a conversation exists) -- a deliberate, documented exception to this
convention, not an oversight to "fix."

## Known Non-Atomic Sequences

`appendMessage` (`repositories/conversations.ts`) checks the conversation is
owned-and-not-deleted, then inserts the message and touches the parent
conversation's `updatedAt` -- the insert and the touch are atomic with each
other (`db.batch`, since `neon-http` has no `db.transaction` -- see that
function's own doc comment), but the ownership check is a separate,
earlier read. A conversation soft-deleted between the check and the insert
is a narrow TOCTOU window ([#220](https://github.com/uw-ssec/llteacher/issues/220)):
not closed here, left open deliberately rather than adding a second
`db.batch` round or a `WHERE` clause on the insert itself, which would need
its own design pass (an insert can't conditionally no-op the way an update
can). Revisit if this ever becomes reachable at meaningful concurrency.

## Message Ordering

`messages.seq` (a global `bigserial`, [#221](https://github.com/uw-ssec/llteacher/issues/221))
is the sort key for every "give me messages in order" query
(`getLastMessages`, `getMessagesForConversation`,
`getSectionConversationMessages` -- [#283](https://github.com/uw-ssec/llteacher/issues/283)
brought the last of the three off `createdAt`) -- not `createdAt`.
`createdAt` is `timestamptz` (microsecond resolution) and was safe as the
sole ordering key only because each `appendMessage` call is its own
separate transaction, so two rows could never share a timestamp; `seq`
makes that guarantee independent of that fact, and survives a future change
to batch multiple message writes into one transaction. Keep `createdAt` for
display (it's the value `formatUpdatedAt`-style UI code wants); use `seq`
for ordering only.

### Migrations Touching `messages`

`messages` is the fastest-growing table in the schema and, unlike most
tables this project has migrated so far, is never empty in a real
deployment by the time a new migration runs against it. A plain
`drizzle-kit generate` diff for a `NOT NULL` column with no explicit
default (a `bigserial`, in particular) assigns values in whatever order
Postgres's `ALTER TABLE` rewrite happens to scan the heap -- which has no
relationship to `created_at`, and can vary between a fresh table and one
that has seen deletes or a `VACUUM` ([#269](https://github.com/uw-ssec/llteacher/issues/269)
demonstrated both silently reordering a populated `messages` table in
Postgres 16, one via free-space reuse, one via `synchronize_seqscans` alone
with zero deletes). The rule this repo has now hand-applied three times
(migrations 0018, 0021, 0023): add the column nullable, backfill it with an
explicit `UPDATE ... ORDER BY` (or `row_number() OVER (...)` into a real
sequence for a strictly-ordered column like `seq`), then `SET NOT NULL`.
Never trust `drizzle-kit generate`'s raw output for a `NOT NULL` column on
this table without checking whether it included a backfill.

Separately: 0023's column-add and its three index builds run as ordinary
(non-`CONCURRENTLY`) DDL, which takes `ACCESS EXCLUSIVE` for the duration.
Fine at current volume; revisit the online (`CONCURRENTLY`, multi-step)
pattern before this table is large enough for that lock to be felt in
production.

## Pinned AI SDK Versions

`apps/web/package.json` pins `ai`, `@ai-sdk/react`, and `@ai-sdk/openai` to
exact versions ([#229](https://github.com/uw-ssec/llteacher/issues/229)),
not a `^` range. `routes/chat.ts` depends on two undocumented internals of
`ai@5.0.195`: the AI SDK's step machinery unconditionally pushing a
`{ type: "step-start" }` marker part onto `responseMessage.parts` (see
`hasRenderableContent`'s doc comment in that file), and the exact
`UIMessageChunk` shapes `replayPersistedPart` hand-constructs to impersonate
a `streamText` response on the idempotency-replay path. A `^5.0.0` range
would let `npm install` float either out from under the code with no
review. `chat.errorChunk.integration.test.ts` drives a real `streamText()`
against an erroring model and would catch a `step-start` regression in CI;
the replay-chunk shapes have thinner coverage, so treat any bump of these
three packages as a deliberate, reviewed change, not a routine update.

## Client Architecture Notes

Two decisions live in code comments in `apps/web/src/client/` rather than
here, because they're small enough to stay next to the code they explain --
noted here only as a pointer so they're easy to find:

- **Two independent `useChat` instances in `App.tsx`** (one for the
  homework-section chat, one for the tutor rail's active conversation) --
  see the doc comment above the tutor `useChat` call in `App.tsx` for why
  they're deliberately not unified into one, including why one is keyed by
  `id` and the other isn't.
- **The tutor rail's IA** (a second collapsible sidebar zone, not a new
  route or a merge into the homework `Sidebar`) -- see
  `TutorConversationsList.tsx`'s file-level doc comment.

## Section Submissions Are One Per (Student, Section)

`submissions` carries denormalized `user_id`/`section_id` alongside
`conversation_id`. They are not maintained by convention: a composite foreign
key ties `(conversation_id, user_id, section_id)` to
`conversations (id, owner_user_id, section_id)`, so Postgres rejects any
submission whose pair disagrees with the conversation it names. `UNIQUE
(user_id, section_id)` sits on top of that and is only trustworthy because of
it.

Write those two columns from the conversation row you already read to
authorize the write -- not from a second lookup. The FK will catch a mismatch
either way, but a single read leaves no window in which the values could
disagree in the first place. `createSubmission` is the reference shape.

Two rules follow from the same constraint:

- **A submission can only ever attach to a `section` conversation.**
  `submissions.section_id` is `NOT NULL`; a tutor conversation's is `NULL`;
  the FK can never match. The `kind = 'section'` check in `createSubmission`
  now produces a friendly error rather than being the only thing preventing
  the row.
- **Restarting a section voids its submission.** Use
  `restartSectionConversation` (`repositories/submissions.ts`), which
  soft-deletes the conversation and deletes the submission in one atomic
  group. A bare `softDeleteConversation` *refuses* a conversation that has a
  submission, because soft-deleting it alone would leave the submission row
  alive against a conversation the student can no longer see -- and the
  replacement's submit would then be the second row for that section.

A graded submission cannot be restarted. `restartSectionConversation` checks
and throws `SubmissionGradedError` (route layer maps it to 409), but the rule
does not depend on that check: `grades.submission_id` is `ON DELETE RESTRICT`,
so Postgres refuses the delete regardless.

**This cap is an accepted simplification, not a settled product rule.**
Restart deletes the submission row outright, so the platform keeps no attempt
history — no record that an earlier submission existed, when it happened, or
how many tries a student took. Discussion
[#249](https://github.com/uw-ssec/llteacher/discussions/249) argues
`submissions` should instead be an append-only attempt table; that was
deferred to ship #27, not refuted. Work item:
[#250](https://github.com/uw-ssec/llteacher/issues/250). Read #249 before
changing the shape of this table.

Two consequences worth knowing before you touch either path:

- **A graded section can still be resubmitted**, which silently leaves the
  grade describing replaced work, even though it cannot be *restarted*
  ([#258](https://github.com/uw-ssec/llteacher/issues/258)). That asymmetry
  falls out of `grades`' RESTRICT FK, not from a decision.
- **The student must be told what restart discards** before they commit to
  it. That disclosure contract is
  [#248](https://github.com/uw-ssec/llteacher/issues/248), not this document.

Rationale, and the superseded/locked alternatives that were rejected:
[docs/superpowers/specs/2026-08-11-submission-uniqueness-design.md](../../docs/superpowers/specs/2026-08-11-submission-uniqueness-design.md)
([#128](https://github.com/uw-ssec/llteacher/issues/128)).

## Deploy Order

**Migrate before deploy, always** ([#284](https://github.com/uw-ssec/llteacher/issues/284)).
`npm run deploy` runs `db:migrate` first for exactly this reason -- do not
call `wrangler deploy` directly, and do not reorder the two in CI when that
pipeline exists.

The hazard is one-directional and comes from Drizzle's schema being shared
between the query builder and the migrator: any migration that adds a
column read via `db.select().from(...)` -- `messages.seq`/`client_message_id`
(0023) are the current example -- means the *new* Worker bundle's queries
reference a column the *old*, not-yet-migrated database doesn't have.
Deploying the Worker first turns every `POST /api/chat` into `42703 column
messages.seq does not exist` -> a 500. Client-side, that 500 surfaces as a
history-fetch failure, and prior to #276 that failed open into a silently
empty transcript rather than a visible error -- so a wrong-order deploy
presented to a student as their conversation history having vanished, not
as an outage.

Rolling the Worker **back** after migrating forward is safe: `seq` has a
`nextval` default and `client_message_id` is nullable, so pre-migration
code inserts and selects cleanly against the post-migration schema. Only
forward-Worker-before-forward-migration is the ordering that breaks.
