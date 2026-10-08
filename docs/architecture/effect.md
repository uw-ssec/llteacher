# Effect 4 in the API: typed errors and dependencies

The Hono API (`apps/web/src/server`) runs its request handlers as
[Effect 4](https://effect.website) programs. This page covers the contract
every handler follows. The code that implements it is in
`apps/web/src/server/effect/`.

## Why

Before this change, a handler's failure modes lived in `throw`s and
`instanceof` chains. The type system did not know that
`startSectionConversation` can refuse with `SectionNotInteractiveError`.
Two kinds of mistake therefore compiled cleanly and only showed up at
runtime:

- **A forgotten refusal.** An expected condition fell through to the
  generic 503.
- **A bare `catch`.** An outage was reported as a routine 404.

With Effect, a handler's type is `Effect<Response, E, R>`:

- **`E` lists every way the handler can fail.** The bridge accepts a
  handler only when `E` contains nothing but `HttpError`, the closed set it
  knows how to answer. A refusal the handler forgot to translate is a
  compile error.
- **`R` lists every service the handler depends on** (`Database`,
  `AppConfig`). The bridge provides them from the request's bindings.
  Tests substitute them, and a requirement nobody provides is a compile
  error.

## The pieces

| File | What it holds |
| --- | --- |
| `effect/errors.ts` | Request outcomes: `Unauthorized`, `Forbidden`, `BadRequest`, `NotFound`, `Conflict`. Dependency failures: `DatabaseError` (with `reason` `unavailable`, `constraint` or `query`), `ExternalServiceError` (with `service`). Also `RuntimeConfigError`. |
| `effect/services.ts` | `AppConfig` and `Database` services, `requestLayer(env)`, `query(...)` for repository calls, `external(...)` for third-party calls. |
| `effect/http.ts` | `effectHandler(...)`, the single `errorResponse` status mapping (exhaustive, checked with `absurd`), `fromThrown` for `app.onError`, and the `requireAuthContext` / `requireCourseAccess` guards. |

### Status mapping

| Failure | Status | Body |
| --- | --- | --- |
| `Unauthorized` | 401 | `{ error: "Unauthorized" }` |
| `Forbidden` | 403 | `{ error: message }` |
| `BadRequest` | 400 | `{ error: message }` |
| `NotFound`, `TenancyMismatchError` | 404 | `{ error: message }` |
| `Conflict`, `PromptTemplateConflictError` | 409 | `{ error: message, code? }` |
| `IdempotencyKeyConflictError` | 409 | `{ error, code: "duplicate_message" }` |
| `DatabaseError`, `ExternalServiceError`, defects | 503 | generic message; the cause is logged as one JSON line with `tag`, `operation`, and `reason` or `service` |

## Writing a handler

```ts
export const restartHandler = effectHandler((c) => Effect.gen(function* () {
  const { authContext, courseId, scope } = yield* requireCourseAccess(c);
  const id = c.req.param("conversationId");
  if (!id || !UUID_RE.test(id)) return yield* new NotFound({ message: "Conversation not found" });

  const result = yield* query(
    "restartSectionConversation",
    (db) => restartSectionConversation(db, /* ... */),
    // The refusals this call is documented to throw. Listing them keeps
    // their types in E; anything else becomes a DatabaseError.
    [SubmissionGradedError, ConversationNotFoundError],
  ).pipe(Effect.catchTags({
    SubmissionGradedError: (e) => Effect.fail(new Conflict({ message: e.message })),
    ConversationNotFoundError: () => Effect.fail(new NotFound({ message: "Conversation not found" })),
  }));
  return c.json(result, 201);
}));
```

Rules:

1. **Every repository call goes through `query`.** Every third-party call
   (WorkOS, the LLM gateway, Canvas, S3, okf) goes through `external`.
   Never `await` one directly inside a handler.
2. **List exactly the refusal classes a call throws.** Translate each one
   with `Effect.catchTags`. Do not list a class to silence the compiler;
   the list is the documented failure surface.
3. **Fail with a request outcome; don't `return c.json(..., 4xx)`.**
   Keep the existing body text; clients branch on it.
4. **Repository refusal classes carry a `_tag`.** Keep them as `Error`
   subclasses so `instanceof` callers keep working. A new refusal class
   needs `readonly _tag = "Name" as const`.
5. **A plain `throw new Error(...)` that request input can reach is an
   undeclared refusal.** Give it a tagged class and declare it.
6. **Keep each export's name and its `(c) => Promise<Response>` shape.**
   The route table, and the route tests that call handlers directly with
   mocked repositories, stay unchanged.

## Testing

- **Route suites** keep mocking repository modules and `makeDb`. The
  `Database` layer calls the mocked `makeDb`, so existing tests are
  regression tests for the migration.
- **`effect/http.test.ts`** checks the status mapping, that defects are
  logged and answered 503, and, using `@ts-expect-error`, that an
  untranslated refusal or a missing service does not compile.
- **`effect/e2e.integration.test.ts`** boots the real Node server against
  Postgres (`DATABASE_URL`). It drives real requests through each error
  class end to end, then repeats them against an unreachable database to
  check the `DatabaseError` path.

## What typing the error channels found

Converting every handler meant listing every way each call can fail. The
handler types are now the inventory: hover a handler's Effect to see its
`E`. The list below is what that exercise turned up that nobody had
written down.

**Bugs: an outage reported as a routine answer**

- `PATCH /api/sections/:id/answer` and `PATCH /api/widgets/:id/response`
  had a bare `catch`, so a dropped database connection answered 403. It
  now answers a logged 503.
- `createCollection` had a bare `catch` that turned every failure into 409
  "name already exists". Now only the unique-name violation
  (`CollectionNameExistsError`) is a 409.
- After a successful Canvas sync, a database failure was reported as 502
  "Could not reach Canvas" and the run was marked failed. It is now a 503
  and the sync status is left alone.

**Bugs: a client error reported as an outage, or the reverse**

- Deleting a submitted conversation hit a plain `throw` and answered 503.
  It is now `ConversationHasSubmissionError`, a 409.
- An unknown widget id on homework update answered 503. It is now
  `ContentDiffError`, a 422.
- On homework update, the old `/order|section/` message regex echoed raw
  Postgres text in a 422. Now:
  - out-of-range order is a `ContentDiffError` with a readable message;
  - section or widget values Postgres refuses (SQLSTATE 22xxx, 23502,
    23514) answer 422 "Section or widget content is invalid.";
  - everything else is a 503.
- `createDocument`: an invalid path now gets its 400 even when knowledge
  storage is not configured.
- An unparseable multipart upload, or a malformed `%` escape in a path,
  now answers 400 instead of 503.
- When storage is unconfigured, best-effort upload cleanup no longer
  answers 503 after the deletion has already happened.

**Bug: a chat turn left locked**

- When the LLM provider rejected a request before any stream existed,
  `onFinish` never finalized the turn. The turn lock stayed held for 90
  seconds, and every Retry in that window got a false 409 `in_progress`.
  The turn is now finalized with `errorFlag`, and a real-SDK integration
  test covers it.

**Hidden refusals, now tagged classes**

Each was previously a plain `throw new Error(...)` that request input
could reach:

- `SectionAnswerSectionNotFoundError`, `SectionNotAnswerableError`,
  `SectionAnswerHomeworkClosedError`
- `WidgetNotFoundError`
- `ConversationHasSubmissionError`
- `ContentDiffError`
- `CollectionNameExistsError`

**Leak fixed**

- A `requestHint` tool failure used to send the raw driver message to the
  model, where it was persisted with the turn. The tool now sends a fixed
  sentence and the failure is logged with its classification.

**Deliberately left as they are**

These were noted but not changed:

- Missing `ENCRYPTION_KEY` or `BLIND_INDEX_KEY` at request time is a
  defect: a logged 503, the same as before.
- The 413, 422, 429 (with `Retry-After`), 502 and custom-body 503
  responses are built in the route; they have no `HttpError` member.
- Non-UUID material and collection ids still reach Postgres (503).
- A WorkOS outage at the login callback still answers 401, which an
  existing test pins; it is now logged with `service: "workos"`.
