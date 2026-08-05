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
and `appendMessage` currently enforce `CourseScope` only: any member of the
course (student or instructor) can soft-delete or append to any other
student's conversation by UUID, since neither function checks the row's
`ownerUserId` against the caller. Not yet exploitable -- no M3 route calls
either function today -- but the gap needs an owner before the first
conversation route ships with it silently unenforced (found + tracked as
[#134](https://github.com/uw-ssec/llteacher/issues/134)).

**Decision:** row ownership is the M3 route layer's responsibility, not the
repository layer's -- extending the same split this doc already draws
("guards decide *who*"; repositories decide *which org's rows*) with a third
tier routes own: *which row within the org*. Routes already have
`AuthContext.session.userId` and `AuthContext.isInstructorOf(courseId)`
(`server/middleware/roles.ts`); when M3 adds conversation routes,
`softDeleteConversation`/`appendMessage` (and any new conversation-mutating
repository function) grow an explicit `requesterId` parameter so the
ownership check runs in the same query that already fetches the row --
avoiding a separate read-then-check race -- but the *policy* (self-only, or
self-or-instructor-override) is the calling route's decision to pass in, not
something the repository infers on its own.
