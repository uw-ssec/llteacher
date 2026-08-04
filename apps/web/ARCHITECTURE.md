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
