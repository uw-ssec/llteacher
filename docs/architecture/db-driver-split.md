# DB Driver Split: `client.ts` vs `nodeClient.ts`

Two Drizzle clients exist for `apps/web`'s Postgres database, deliberately, for different runtimes. This doc explains why, whether it's a prod risk (it isn't), and what to reconsider later.

- `apps/web/src/db/client.ts` — `makeDb()`. Used by **all production route/middleware code** (`server/routes/*.ts`, `server/middleware/*.ts`, `server/repositories/*.ts` at request time).
- `apps/web/src/db/nodeClient.ts` — `makeNodeDb()`. Used by **Vitest integration tests** and the `db:seed` script (`apps/web/scripts/seed.ts`, landing in M2 issue #17). Never imported by production route code.

Discovered 2026-08-03 while implementing the first real-DB integration test for [issue #2](https://github.com/uw-ssec/llteacher/issues/2) (M2 epic, [#18](https://github.com/uw-ssec/llteacher/issues/18)). No test before that point ever opened a real database connection — every existing test mocks `db/client.ts`'s `makeDb` — so this had never been exercised.

## The problem

`makeDb()` builds its client like this:

```ts
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

export function makeDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}
```

`@neondatabase/serverless`'s `neon()` does **not** speak the standard Postgres wire protocol. It speaks Neon's own HTTP proxy protocol — every query becomes an HTTP POST to a Neon-specific `/sql` endpoint that a real Neon project's edge proxy terminates and translates into a real Postgres query. This is *why* the driver exists at all: Cloudflare Workers cannot open raw TCP sockets, so a Worker cannot use a normal Postgres driver (`pg`, `postgres.js`, etc.) no matter what — HTTP-over-fetch is the only transport available to it. Neon built this driver specifically to make Postgres reachable from environments like Workers.

The consequence: `makeDb()` can **only** connect to an endpoint that actually runs Neon's proxy — i.e., a real Neon-hosted database. Point it at anything else — a local `docker run pgvector/pgvector:pg16`, or the plain Postgres service container GitHub Actions spins up in `.github/workflows/test.yml` — and every query fails immediately:

```
NeonDbError: Error connecting to database: fetch failed
```

This is not a flaky-connection or wrong-port problem. It is a protocol mismatch — the client is trying to speak HTTP-to-a-Neon-proxy to a server that only speaks Postgres-wire-protocol-over-TCP. No amount of retrying, port-forwarding, or URL fiddling fixes it; the two sides are running fundamentally different protocols on the wire.

## Does this affect production?

**No.** Production's Cloudflare Worker connects to a real Neon-hosted Postgres project, which does run Neon's HTTP proxy. `makeDb()` works exactly as intended there — this is genuinely the correct, in fact the *only*, viable driver for the Worker runtime. Nothing about this issue or its fix touches `client.ts` or any file that imports it for production request handling.

**Where it does bite:**
- **Local dev**, if a developer runs a local/Dockerized Postgres instead of pointing `DATABASE_URL` at a personal Neon branch (see `apps/web/README.md` setup steps — `.dev.vars` is meant to hold a real Neon connection string, but nothing stops someone from running `docker run postgres` locally and pointing `DATABASE_URL` at it for convenience).
- **CI**, specifically: `.github/workflows/test.yml`'s `web` job runs `pgvector/pgvector:pg16` as a service container and sets `DATABASE_URL` to point at it. `drizzle-kit migrate` (used for the migration-apply CI step) was never affected — see below — but any Vitest test or script that called `makeDb()` against that CI `DATABASE_URL` would fail the same way it does locally.
- **Integration tests generally** — any test that wants to exercise a real query against real Postgres (constraint checks, cascade behavior, cross-org isolation proofs) needs a client that can talk to whatever `DATABASE_URL` CI/local dev actually provides, which is plain Postgres, not a Neon proxy.

## Why `drizzle-kit` (migrations) was never affected

`apps/web/drizzle.config.ts` configures `drizzle-kit` (the CLI used for `npm run db:generate` / `npm run db:migrate`) completely independently of `client.ts`:

```ts
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

`drizzle-kit` has its own internal connection logic for the `postgresql` dialect that uses a standard TCP Postgres driver (`npm run db:migrate` logs `Using 'pg' driver for database querying`). `pg` is a real devDependency of `apps/web`, added specifically so `drizzle-kit` could reach a plain Postgres instance in CI (see the auth-milestone PR that added it, `apps/web/package.json`). This is a completely separate code path from `makeDb()` — migrations have always worked fine against local/CI Postgres; only the app's own query client (`makeDb`) has this constraint.

## The fix: `nodeClient.ts`

`apps/web/src/db/nodeClient.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import type { Db } from "./client";

export function makeNodeDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema }) as unknown as Db;
}
```

This reuses the same `pg` package `drizzle-kit` already depends on, over a real TCP connection — which works against local Docker Postgres, the CI service container, *and* a real Neon database (Neon is a fully Postgres-wire-protocol-compatible service; the HTTP proxy is an additional interface it offers specifically for environments like Workers that can't do raw TCP, not a replacement for the standard protocol).

**Who uses which client:**

| Caller | Client | Why |
|---|---|---|
| `server/routes/*.ts`, `server/middleware/*.ts` (production request path) | `makeDb()` (`client.ts`) | Runs inside the Cloudflare Worker — only the HTTP driver works there at all |
| Vitest integration tests (`*.test.ts` using a real `DATABASE_URL`) | `makeNodeDb()` (`nodeClient.ts`) | Runs as a plain Node process (Vitest); needs to reach local/CI plain Postgres |
| `apps/web/scripts/seed.ts` (`db:seed`, M2 issue #17) | `makeNodeDb()` (`nodeClient.ts`) | Runs as a plain Node process via `tsx`, same constraint as `drizzle-kit` and Vitest — not inside the Worker |

### The `as unknown as Db` cast

`drizzle-orm/neon-http`'s `NeonHttpDatabase<TSchema>` and `drizzle-orm/node-postgres`'s `NodePgDatabase<TSchema>` both extend the same `PgDatabase<TQueryResultHKT, TSchema>` base class, but with a different `TQueryResultHKT` type parameter (it describes the shape of a *raw* query result, e.g. from `db.execute(sql\`...\`)`). TypeScript can't structurally unify the two types because of that parameter, even though every method this codebase actually calls — `.select()`, `.insert()`, `.update()`, `.delete()`, `.query.<table>.findMany()`/`.findFirst()`, `.transaction()` — is generic purely over the shared `schema`, and behaves identically regardless of which concrete driver is underneath.

The cast is a deliberate, narrow escape hatch, not a blind `any`. It holds as long as **no code in this repository calls `db.execute()` with a raw SQL result whose shape depends on the driver-specific `TQueryResultHKT`**. As of this writing, nothing does. If that changes (e.g. a future PR adds a raw `db.execute(sql\`...\`)` call and destructures Neon-specific result fields), the cast could start hiding a genuine incompatibility for anything using `nodeClient.ts` against that code path — worth a search for `.execute(` across the repo if this doc is being revisited for that reason.

## What to reconsider later

- **If CI/local dev ever gets real ephemeral Neon branches** (e.g. via [Neon's branching API](https://neon.tech/docs/guides/branching-intro) spun up per CI run instead of a plain Postgres service container), `nodeClient.ts` becomes unnecessary for CI — a Neon branch runs the real proxy, so `makeDb()` would work directly against it. `nodeClient.ts` would still be worth keeping for fully-offline local dev (no network dependency on Neon), but the CI-specific driver mismatch would disappear. Worth revisiting if the team ever prioritizes CI speed/cost over the current "plain Postgres container" simplicity.
- **If `drizzle-orm` is upgraded past the current `^0.36.0` pin** in a way that changes `PgDatabase`'s generics or adds behavior that depends on `TQueryResultHKT`, re-verify the cast in `nodeClient.ts` still holds (re-run the full test suite; a silent behavioral divergence would show up as tests passing locally against `nodeClient` but the equivalent code failing against `client.ts` in production, or vice versa).
- **No lint rule currently prevents production route code from importing `nodeClient.ts`.** If that ever happens by accident (e.g. someone copies a pattern from a test into a route file), it would deploy fine — `pg`'s TCP driver just silently doesn't work inside a Workers runtime at request time, it would throw at the first query in production. This is enforced by convention/code-review only right now, same as the [routes-vs-repositories convention](../../apps/web/ARCHITECTURE.md) added alongside it. Consider a lint rule (e.g. `no-restricted-imports` scoped to `src/server/**` banning `db/nodeClient`) if this ever actually happens.

## See also

- `apps/web/src/db/client.ts` — production client (`makeDb`)
- `apps/web/src/db/nodeClient.ts` — Node-process client (`makeNodeDb`)
- `apps/web/drizzle.config.ts` — the separate `drizzle-kit` driver config that was never affected by this
- [docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md](../superpowers/plans/2026-08-03-m2-runtime-persistence.md) — "Resolved Design Decisions" #9, where this was first recorded during Phase 1 execution
- [`.github/workflows/test.yml`](../../.github/workflows/test.yml) — the CI Postgres service container that surfaced this
