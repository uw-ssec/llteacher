# Conversations & Chat API

Consumer-facing reference for the conversation and chat HTTP routes served by
`apps/web` (Hono on Cloudflare Workers). Written for an integrator outside this
repo: everything below is the contract you code against, not an internal
invariant. For internal invariants (tenancy scoping, the routes-vs-repositories
split) see [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).

Source of truth for this document:

| Concern | File |
| --- | --- |
| Route table / error mapping | `src/server/index.ts` |
| Tutor conversation CRUD + history | `src/server/routes/conversations.ts` |
| Chat turn | `src/server/routes/chat.ts` |
| Section-conversation lifecycle | `src/server/routes/sectionConversations.ts` |
| Section submission | `src/server/routes/submissions.ts` |
| Wire types | `src/shared/types.ts` |

---

## Contents

- [Route index](#route-index)
- [Conventions](#conventions)
  - [Authentication](#authentication)
  - [Error body shape](#error-body-shape)
  - [404-not-403 (row ownership) vs. 403 (course scope)](#404-not-403-row-ownership-vs-403-course-scope)
  - [Malformed UUIDs](#malformed-uuids)
  - [Rate limits](#rate-limits)
  - [⚠ `before` means two different things](#-before-means-two-different-things)
- [Tutor conversation routes](#tutor-conversation-routes)
- [`POST /api/chat`](#post-apichat)
  - [The `x-conversation-id` protocol](#the-x-conversation-id-protocol)
  - [The `id` idempotency key](#the-id-idempotency-key)
  - [Worked two-turn example](#worked-two-turn-example)
- [Section-conversation routes](#section-conversation-routes)
- [Submission](#submission)
- [Known gaps](#known-gaps)

---

## Route index

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/conversations` | List the caller's conversations in a course |
| `POST` | `/api/conversations` | Create a tutor conversation |
| `GET` | `/api/conversations/:id/messages` | Page a conversation's message history |
| `PATCH` | `/api/conversations/:id` | Rename a conversation |
| `DELETE` | `/api/conversations/:id` | Soft-delete a conversation |
| `POST` | `/api/chat` | Send one turn; stream the tutor's reply |
| `POST` | `/api/conversations/:id/submit` | Submit a section conversation |
| `POST` | `/api/courses/:courseId/sections/:sectionId/conversations` | Start a section conversation |
| `GET` | `/api/courses/:courseId/sections/:sectionId/conversation` | Get the caller's active section conversation |
| `GET` | `/api/courses/:courseId/conversations/:conversationId` | Get one section conversation (grader-readable) |
| `POST` | `/api/courses/:courseId/conversations/:conversationId/restart` | Restart a section conversation |

Two conversation *kinds* exist and are not interchangeable:

- **tutor** — free-standing, course-scoped scratch conversations. `sectionId`
  is `null`. Managed by the `/api/conversations` routes.
- **section** — a student working one homework section. Managed by the
  `/api/courses/.../conversations` routes. `GET /api/conversations` can
  *list* these with `kind=section`, but it will not create them.

Not covered here (instructor-console reads, different audience and guard tier):
`GET /api/courses/:courseId/instructor/transcripts[/:conversationId]`.

---

## Conventions

### Authentication

Every `/api/*` route except `/api/auth/*` requires a session cookie,
`llt_session`, set by the WorkOS AuthKit login flow (`GET /api/auth/login` →
`GET /api/auth/callback`). There is no API-key or bearer-token path today.

A request with no valid session is rejected by middleware before any handler
runs:

```
401 {"error":"Unauthorized"}
```

`POST /api/chat` adds a `code` when its own handler-level re-check fires:
`{"error":"Unauthorized","code":"unauthorized"}`. Treat both as the same
condition.

Beyond the session, each route enforces course membership and row ownership —
see the next two sections.

### Error body shape

Every error response is JSON:

```jsonc
{ "error": "human-readable sentence", "code": "machine_readable_slug" }
```

`code` is present on **`POST /api/chat` only** (and on the global
`duplicate_message` mapping). Every other route returns `{ "error": ... }` with
no `code`. Branch on the HTTP status plus, for `/api/chat`, `code` — never on
the `error` sentence.

`code` values emitted by `/api/chat`:

| `code` | Meaning | Worth retrying? |
| --- | --- | --- |
| `unauthorized` | No session | No — re-authenticate |
| `denied` | Not a member of the named course | No |
| `not_found` | Conversation or section not visible to you | No |
| `in_progress` | A turn on this conversation is already in flight | Yes, shortly |
| `duplicate_message` | Your `id` already stores different content | **No — permanent** |
| `rate_limited` | Per-user request budget exhausted | Yes, after `Retry-After` |
| `hint_budget_exceeded` | Section hint budget exhausted | No |
| `history_too_long` | Request body or `messages` array too large | No — send less |
| `unavailable` | Server-side LLM misconfiguration | No |
| `tutor_stopped` | Mid-stream provider failure (delivered *inside* the stream, not as a status) | Yes |

Any unhandled server error becomes:

```
503 {"error":"Something went wrong. Please try again later."}
```

### 404-not-403 (row ownership) vs. 403 (course scope)

Two different hiding policies apply, at two different layers. Both are
deliberate. Knowing which one you hit tells you what to fix.

| | **Course scope → 403** | **Row ownership → 404** |
| --- | --- | --- |
| Question asked | "Is the caller a member of *this course*?" | "Does *this row* exist and belong to the caller?" |
| Checked by | `courseScopeFromAuthContext` against the caller's membership list | `getOwnedConversationOrNull` against the row's `ownerUserId` |
| Response | `403 {"error":"Course access denied"}` | `404 {"error":"Conversation not found"}` |
| Routes | `GET`/`POST /api/conversations`, `POST /api/chat`, every `/api/courses/:courseId/...` route | `GET /api/conversations/:id/messages`, `PATCH`/`DELETE /api/conversations/:id`, `POST /api/chat` with a `conversationId` |

Why the split: a course id is something you already know (you asked for it), so
refusing it by name leaks nothing. A conversation id is a *guessable* opaque
handle, so a 403 there would confirm "this conversation exists, it just isn't
yours" — an existence oracle. The 404 therefore collapses **three** distinct
states into one indistinguishable response:

1. no such conversation,
2. it exists but is owned by someone else,
3. it exists, is yours, but is soft-deleted.

Do not try to distinguish them; the API will not help you, by design.

The same collapse applies to sections: to a caller who cannot view drafts, an
unreleased (draft / scheduled / hidden / expired) section is indistinguishable
from one that does not exist. Which 404 body you get depends on what you asked
for, not on which condition was true — `{"error":"Section not found"}` from
`POST /api/chat` and the section-start route, `{"error":"Conversation not
found"}` from the two section-conversation read routes.

**One documented exception.** `POST /api/conversations/:id/submit` collapses
its "not found or not accessible" cases to a uniform **403**, not a uniform
404:

```
403 {"error":"Conversation not found or not accessible"}
```

Same non-oracle property (one status for all three states), opposite status
code. Do not infer from a 403 there that the conversation exists.

### Malformed UUIDs

Path and body ids that are not UUID-shaped are rejected at the route layer,
before any database call:

| Where | Behavior |
| --- | --- |
| `:id` path param on `/api/conversations/:id[/messages]` | `404 {"error":"Conversation not found"}` — same body as a genuine miss |
| `:sectionId` / `:conversationId` path params on the section routes | `404 {"error":"Section not found"}` / `404 {"error":"Conversation not found"}` |
| `conversationId` / `courseId` / `sectionId` in the `/api/chat` body | `400 {"error":"conversationId/courseId/sectionId must be valid UUIDs when present; kind must be 'tutor' or 'section'"}` |

A malformed `courseId` **query** param on `GET /api/conversations` is neither —
it fails the membership check and returns `403 "Course access denied"`, because
membership is matched in memory before any query runs.

The one route with no such guard is `POST /api/conversations/:id/submit`; see
[Known gaps](#known-gaps).

### Rate limits

`POST /api/chat` and `POST /api/conversations` share **one** per-user budget:
**20 requests per 60 s window**. The window is *fixed*, not sliding — buckets
are aligned to `floor(now / 60s)`, so the budget resets on the wall-clock
minute boundary rather than 60 s after your first request. Every request that
reaches the gate consumes a slot, including ones that go on to fail validation.

```
429 {"error":"You're sending messages too quickly. Please wait a moment and try again.","code":"rate_limited"}
Retry-After: 60
```

(`POST /api/conversations` returns the same 429 with `"...sending requests too
quickly..."` and no `code`.)

A separate, non-time-based cap applies to conversation creation: **300 live
tutor conversations per course per user**. Soft-deleted ones do not count.

```
429 {"error":"You've reached the limit of 300 tutor conversations for this course. Delete an old one to make room."}
```

This one carries **no** `Retry-After` — waiting will not help; delete a
conversation.

### ⚠ `before` means two different things

Both list routes take a query parameter spelled `before`. They are not the same
type and are not interchangeable. Passing one where the other belongs is a 400,
not a silent mis-page.

| Route | `before` is | Constructed by | Example |
| --- | --- | --- | --- |
| `GET /api/conversations` | An **opaque, server-issued cursor string** (base64) | The server. Echo back the previous response's `nextCursor` verbatim. | `eyJ1cGRhdGVkQXQiOiIyMDI2LTA4LTAxVDAwOjA1OjAwLjAwMFoiLCJpZCI6IjIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyMiJ9` |
| `GET /api/conversations/:id/messages` | An **integer `seq`** | You, from a message's `seq` field | `42` |

For `GET /api/conversations`, `before` is *not* an ISO timestamp and *not* a
conversation id. It encodes an `(updatedAt, id)` pair so that conversations
touched in the same millisecond are still totally ordered. Do not parse,
construct, or mutate it — its encoding is not part of this contract and may
change. Only `nextCursor` values are valid. Anything else:

```
400 {"error":"before must be a valid cursor from a prior response's nextCursor"}
```

For `GET /api/conversations/:id/messages`, `before` is exclusive (`seq <
before`) and the response's `seq` field exists precisely so you can build the
next one without a second round-trip. A non-integer:

```
400 {"error":"before must be an integer seq value"}
```

There is no `nextCursor` on the messages route — page by taking the `seq` of
the first (oldest) row you received.

---

## Tutor conversation routes

### `GET /api/conversations`

List the **caller's own** conversations in one course, newest-touched first.

**Auth:** session + membership of `courseId`.

| Param | In | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| `courseId` | query | string | **yes** | — | 400 if absent. Not UUID-validated; a course you are not in → 403. |
| `kind` | query | `"tutor" \| "section"` | no | `"tutor"` | Any other value → 400. |
| `limit` | query | integer 1–200 | no | `50` | Must be an integer in range, else 400. |
| `before` | query | opaque cursor | no | — | The previous response's `nextCursor`. See above. |

**200** — `ConversationListResponse`:

```jsonc
{
  "items": [
    {
      "id": "22222222-2222-2222-2222-222222222222",
      "kind": "tutor",
      "title": "Chat 1",
      "createdAt": "2026-08-01T00:00:00.000Z",   // ISO 8601
      "updatedAt": "2026-08-01T00:05:00.000Z",   // ISO 8601, millisecond precision
      "messageCount": 3
    }
  ],
  "nextCursor": null
}
```

Ordering is `updatedAt DESC, id DESC`. Soft-deleted conversations are excluded.
Nothing about ownership, course, or section is on the wire — `ownerUserId`,
`courseId`, `sectionId`, `isDeleted`, and `deletedAt` are all dropped.

`nextCursor` is a **string when a full page came back** (`items.length ===
limit`) and `null` otherwise. A full page is the only available signal that more
rows might exist, so a non-null `nextCursor` does not guarantee a non-empty next
page — a follow-up request returning `{items: [], nextCursor: null}` is normal
and is how you learn you are done.

| Status | Body |
| --- | --- |
| 400 | `{"error":"courseId is required"}` |
| 400 | `{"error":"kind must be 'tutor' or 'section'"}` |
| 400 | `{"error":"limit must be an integer between 1 and 200"}` |
| 400 | `{"error":"before must be a valid cursor from a prior response's nextCursor"}` |
| 401 | `{"error":"Unauthorized"}` |
| 403 | `{"error":"Course access denied"}` |

### `POST /api/conversations`

Create a **tutor** conversation. (Section conversations are created by
[their own route](#section-conversation-routes) or implicitly by `/api/chat`.)

**Auth:** session + membership of `courseId`.

**Body:**

```jsonc
{
  "courseId": "11111111-1111-1111-1111-111111111111", // required, must be a UUID
  "title": "Office hours prep"                        // optional, 1-100 chars after trimming
}
```

`kind` is always `"tutor"`; sending anything else has no effect. An **omitted**
`title` becomes `"New Conversation"`. An **empty or whitespace-only** `title` is
a 400, not a default — `title` is trimmed before its 1–100 length check, and the
stored value is the trimmed one.

**201** — `ConversationSummary` (note: **no `messageCount`** key; a new
conversation has no messages, and clients should default it to 0 rather than
treat its absence as an error):

```jsonc
{
  "id": "22222222-2222-2222-2222-222222222222",
  "kind": "tutor",
  "title": "New Conversation",
  "createdAt": "2026-08-01T00:00:00.000Z",
  "updatedAt": "2026-08-01T00:00:00.000Z"
}
```

| Status | Body |
| --- | --- |
| 400 | `{"error":"Request body must be valid JSON"}` |
| 400 | `{"error":"courseId (uuid) is required; title, if present, must be 1-100 chars"}` |
| 401 | `{"error":"Unauthorized"}` |
| 403 | `{"error":"Course access denied"}` |
| 404 | `{"error":"Not found"}` — the repository's own tenancy re-check failed |
| 429 | rate limit (with `Retry-After: 60`) or the 300-conversation cap (no `Retry-After`) — see [Rate limits](#rate-limits) |

### `GET /api/conversations/:id/messages`

Page a conversation's persisted message history, **oldest first**.

This is not only a display concern. `POST /api/chat` rebuilds the model's
context from persisted history, but any client resuming an existing
conversation must hydrate its own view through this route.

**Auth:** session + row ownership (404, never 403 — see above).

| Param | In | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| `id` | path | UUID | yes | — | Non-UUID → 404 |
| `limit` | query | integer 1–500 | no | `200` | Note the range differs from the list route's 1–200 |
| `before` | query | integer `seq` | no | — | Exclusive. **Not** the list route's cursor. |

**200** — `ConversationMessageResponse[]`, a bare array (no envelope, no
`nextCursor`), ascending by `seq`:

```jsonc
[
  { "id": "m1", "role": "user",      "parts": [{"type":"text","text":"hi"}],    "seq": 1, "createdAt": "2026-08-26T18:04:00.000Z" },
  { "id": "m2", "role": "assistant", "parts": [{"type":"text","text":"hello"}], "seq": 2, "createdAt": "2026-08-26T18:05:30.000Z" }
]
```

- `role` is `"user" | "assistant" | "system"`.
- `parts` is the raw stored jsonb — an array of AI SDK `UIMessage` parts
  (`{type:"text",text}`, `{type:"step-start"}`, `{type:"tool-<name>", ...}`).
  It is deliberately untyped on the wire; validate what you consume.
- `seq` is the paging cursor for the *next, older* page: take the first
  element's `seq` and send it as `before`.
- An empty conversation returns `200 []`, never 404.

| Status | Body |
| --- | --- |
| 400 | `{"error":"limit must be an integer between 1 and 500"}` |
| 400 | `{"error":"before must be an integer seq value"}` |
| 401 | `{"error":"Unauthorized"}` |
| 404 | `{"error":"Conversation not found"}` — missing, not yours, soft-deleted, or a malformed id |

### `PATCH /api/conversations/:id`

Rename a conversation.

**Auth:** session + row ownership.

**Body:** `{"title": "New title"}` — required, 1–100 characters after trimming.

**200** — the updated `ConversationSummary` (same shape as `POST`'s 201, no
`messageCount`).

| Status | Body |
| --- | --- |
| 400 | `{"error":"Request body must be valid JSON"}` |
| 400 | `{"error":"title is required and must be 1-100 chars after trimming"}` |
| 401 | `{"error":"Unauthorized"}` |
| 404 | `{"error":"Conversation not found"}` |

### `DELETE /api/conversations/:id`

Soft-delete a conversation. The row and its messages remain in the database but
disappear from every read path, and the conversation stops counting against the
300-per-course cap. This is not reversible through the API.

**Auth:** session + row ownership.

**204** — empty body, no content type.

| Status | Body |
| --- | --- |
| 401 | `{"error":"Unauthorized"}` |
| 404 | `{"error":"Conversation not found"}` |

Deleting an already-deleted conversation returns 404 (it is invisible to the
ownership check).

---

## `POST /api/chat`

Send one user turn and receive the tutor's reply as a stream. This route also
*creates* the conversation on the first turn when you do not supply a
`conversationId`.

**Auth:** session; then either row ownership of `conversationId`, or membership
of `courseId` when creating.

**Request body:**

```jsonc
{
  // REQUIRED. See "What to send in `messages`" below.
  "messages": [
    {
      "id": "a1b2c3d4e5f6g7h8",                    // REQUIRED — the idempotency key
      "role": "user",
      "parts": [{ "type": "text", "text": "What is a p-value?" }]
    }
  ],

  "conversationId": "2222...",  // omit to create; send it to continue an existing one
  "courseId":       "5555...",  // REQUIRED when conversationId is omitted
  "kind":           "tutor",    // "tutor" | "section"; defaults to "tutor"
  "sectionId":      "7777...",  // REQUIRED when kind === "section"
  "isHintRequest":  false       // optional; a request to treat this turn as a hint
}
```

Field rules:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `messages` | array, 1–500 entries | **yes** | Every element validated, not just the last |
| `messages[].id` | `/^[A-Za-z0-9_-]{1,128}$/` | **yes** | Per-send idempotency key. **Not** a UUID — the AI SDK generates a 16-char alphanumeric id. |
| `messages[].role` | `"user" \| "assistant"` | yes | `"system"` and `"tool"` are rejected outright. The **last** element must be `"user"`. |
| `messages[].parts` | array, 1–32 entries | yes | Each part's `type` must match `^(text\|step-start\|tool-[A-Za-z0-9_]+)$`; a `text` part's `text` is capped at 8 000 characters |
| `conversationId` | UUID | no | Omit to create; supply to continue |
| `courseId` | UUID | conditionally | Required whenever `conversationId` is omitted |
| `kind` | `"section" \| "tutor"` | no | Defaults to `"tutor"` |
| `sectionId` | UUID | conditionally | Required when `kind === "section"` |
| `isHintRequest` | boolean | no | A *request*, not a claim. The server decides and may deny. Ignored for tutor conversations and for conversations with no section. |

Whole-body size cap: **262 144 bytes** (256 KiB), enforced on the raw bytes
before parsing.

**What to send in `messages`.** The server rebuilds the model's context from
its own persisted history — it does **not** trust or use anything before the
last element. The last element is the only one that is persisted, and the only
one that reaches the model as this turn's question. Earlier elements are still
validated (so a malformed one 400s the whole request) but are otherwise
discarded.

So: **send a single-element array containing only the new user message.** The
in-repo browser client already trims its request body to exactly that. Sending
your full local history is permitted up to the 500-entry cap, but it is wasted
bandwidth and cannot influence the model. This is a change from earlier
behavior, where the client-supplied array *was* the model's context.

### Success response

**200**, a Server-Sent Events stream in the Vercel AI SDK "UI message stream"
format:

```
content-type: text/event-stream
cache-control: no-cache
x-vercel-ai-ui-message-stream: v1
x-conversation-id: 22222222-2222-2222-2222-222222222222
x-replayed: true          ← only on an idempotent replay; absent otherwise
```

The body is a sequence of `data: {...}` frames terminated by `data: [DONE]`.
Frame types you will see include `start`, `start-step`, `text-start`,
`text-delta`, `text-end`, `tool-input-available`, `tool-output-available`,
`tool-output-error`, `finish-step`, `finish`. Consume it with the AI SDK's
`useChat` (JS) or parse the SSE frames yourself.

**Errors arrive inside a 200 stream too.** If the model provider fails
mid-generation, the status is already 200 and cannot change; the failure comes
through as an `error` frame whose payload is a JSON *string* containing the
usual envelope:

```jsonc
{"error":"The tutor stopped partway through. Nothing you wrote was lost.","code":"tutor_stopped"}
```

Parse that string as JSON and classify by `code`, the same as a real error
body. When a turn fails this way, **nothing is persisted for the assistant
half** — the transcript keeps your question with no reply. There is no stream
checkpoint and no resume endpoint; recovery is re-asking (reuse the same `id`
and it will de-duplicate rather than double-write your question).

### Status codes

| Status | `code` | `error` |
| --- | --- | --- |
| 400 | — | `Request body must be valid JSON` |
| 400 | `history_too_long` | `Request body exceeds the 262144 byte limit` |
| 400 | — | `conversationId/courseId/sectionId must be valid UUIDs when present; kind must be 'tutor' or 'section'` |
| 400 | — | `messages is required` |
| 400 | `history_too_long` | `messages must contain at most 500 entries` |
| 400 | — | `Every message must have role "user" or "assistant" and a well-formed parts array` ⚠ **also what a missing or malformed `id` gets** — see below |
| 400 | — | `The last message must be a user message with a non-empty parts array` — in practice only reachable when the last element's `role` is `"assistant"`; see below |
| 400 | — | `courseId is required when conversationId is omitted` |
| 400 | — | `sectionId is required when kind is 'section'` |
| 401 | `unauthorized` | `Unauthorized` |
| 403 | `denied` | `Course access denied` |
| 404 | `not_found` | `Conversation not found` |
| 404 | `not_found` | `Section not found` — missing, not in the course, or unreleased to you |
| 409 | `in_progress` | `Section is not interactive and cannot hold a conversation` |
| 409 | `in_progress` | `Another message for this conversation is still being processed. Please wait a moment and try again.` |
| 409 | `in_progress` | `This message is already being processed. Please wait a moment.` |
| 409 | `duplicate_message` | `A message with this clientMessageId already exists with different content` |
| 429 | `rate_limited` | `You're sending messages too quickly. Please wait a moment and try again.` (+ `Retry-After: 60`) |
| 429 | `hint_budget_exceeded` | `You've used all the hints available for this section.` (body also carries `"remainingHints": 0`) |
| 500 | `unavailable` | `I'm sorry, but there's no valid LLM configuration available right now. Reference ID: <uuid>` |
| 503 | `unavailable` | `Something went wrong. Please try again later.` |

⚠ **Which 400 you get for a bad `id` is not the one the wording suggests.**
Validation runs in two passes, and the *first* pass is the one that catches
almost everything:

1. **Every element** — including the last — is checked for a well-formed `id`
   (`/^[A-Za-z0-9_-]{1,128}$/`), a `role` of `"user"` or `"assistant"`, and a
   `parts` array of 1–32 allowed part types. Any failure anywhere in the array
   returns `Every message must have role "user" or "assistant" and a
   well-formed parts array`.
2. **Only then** is the last element checked for `role === "user"`.

So a **missing `id`**, an **`id` that fails the pattern**, and an **empty
`parts` array** all return the *first* message — which does not mention `id` at
all. That is the string to debug an id problem against. If you get it and your
`role`/`parts` look fine on every element, check `id` first.

The second message (`The last message must be a user message with a non-empty
parts array`) is correspondingly narrower than it reads: by the time it can
fire, `id` and `parts` have already passed. In practice the only condition that
reaches it is **a last element whose `role` is `"assistant"`**. Its mention of
a "non-empty parts array" is vestigial — an empty `parts` array is rejected by
pass 1 and never reaches it.

Only **one turn per conversation** may be in flight at a time. A second
concurrent send on the same conversation gets `409 in_progress` immediately. It
is retryable — wait and re-send *the same* `id`.

### The `x-conversation-id` protocol

The conversation id is returned in a **response header**, never in the response
body (the body is a stream of model output). The protocol:

1. **First turn:** omit `conversationId`; send `courseId` (and `kind` +
   `sectionId` for a section conversation). The server creates the conversation.
2. Read `x-conversation-id` off the response headers. It is present on every
   200, including replays.
3. **Every later turn:** send that value back as `conversationId` in the body.

Headers are readable before the stream body is consumed, so capture it as soon
as the response resolves — do not wait for the stream to finish.

If you drop the header you cannot resume the conversation through
`/api/chat`, but you have not lost it: `GET /api/conversations?courseId=...`
will list it (tutor kind), and `GET
/api/courses/:courseId/sections/:sectionId/conversation` will return it
(section kind).

### The `id` idempotency key

`messages[last].id` is the idempotency key for the turn. It must be **unique
per send** — not per message content, not per conversation. De-duplication is
keyed on the id and never on the text, precisely so a student legitimately
sending `"ok"` twice gets two turns.

What happens when the server sees an id it has already stored for this
conversation depends on what is stored under it:

| Stored under that id | Server behavior |
| --- | --- |
| Same content, and the assistant's complete answer to it is the newest message | **200 replay.** The persisted answer is streamed back verbatim. No model call, no new rows. `x-replayed: true` is set. |
| Same content, and it is itself the newest message (no answer yet) | The user message is not re-inserted; the model is called (again) and a fresh answer streams. No `x-replayed`. |
| Same content, and another request is mid-flight for it | `409 {"error":"...already being processed...","code":"in_progress"}` — retryable |
| **Different** content | `409 {"error":"A message with this clientMessageId already exists with different content","code":"duplicate_message"}` — **permanent**, retrying is futile. Nothing is persisted and no model call is made. |

Replay is decided against the **tail** of the conversation, not the whole
transcript: only the newest stored turn is considered. Re-sending an id from
several turns ago — after the conversation has moved on — is therefore not a
replay; it resolves to the existing row and comes back as `409 in_progress`,
which is retryable in shape but will not become a replay by retrying. Reuse an
id only for an immediate retry of the turn you just sent.

Content comparison is structural, not string-based, so a `parts` array that
round-tripped through JSON with reordered object keys still counts as the same
content.

Practical rules for an integrator:

- Generate a **fresh random id for every user send** (16+ chars from
  `[A-Za-z0-9_-]`).
- **Reuse the same id** — deliberately — when retrying a send whose response you
  never received. That is exactly what the replay path exists for.
- Never derive the id from message content, a turn index, or a timestamp with
  low resolution. Any of those will eventually collide with different content
  and produce a permanent `duplicate_message` for a legitimate message.

`x-replayed: true` exists for you, not for the in-browser client: a replay's
stream uses the same frame vocabulary and the same wire protocol as a real
model turn, deliberately, so a stream consumer cannot tell them apart from the
body alone. The header is the only signal. Its **absence** means a real model
call happened; it is never sent as `"false"`.

### Worked two-turn example

Assumes `$COOKIE` holds a valid `llt_session` cookie and `$COURSE` a course you
are a member of. The stream bodies below are abridged — a real turn also emits
`tool-input-start` / `tool-input-delta` frames while the model is composing a
tool call, and many more `text-delta` frames.

**Turn 1 — no `conversationId`; the server creates one.**

```bash
curl -i -X POST https://<host>/api/chat \
  -H "content-type: application/json" \
  -H "cookie: llt_session=$COOKIE" \
  -d '{
        "courseId": "'"$COURSE"'",
        "kind": "tutor",
        "messages": [
          { "id": "kf83jd0alq72mzx1", "role": "user",
            "parts": [{ "type": "text", "text": "What is a p-value?" }] }
        ]
      }'
```

```
HTTP/1.1 200 OK
content-type: text/event-stream
x-vercel-ai-ui-message-stream: v1
x-conversation-id: 22222222-2222-2222-2222-222222222222

data: {"type":"start"}
data: {"type":"start-step"}
data: {"type":"text-start","id":"…"}
data: {"type":"text-delta","id":"…","delta":"A p-value is "}
data: {"type":"text-delta","id":"…","delta":"the probability of …"}
data: {"type":"text-end","id":"…"}
data: {"type":"finish-step"}
data: {"type":"finish"}
data: [DONE]
```

No `x-replayed` header — this was a real model call.

**Turn 2 — echo `x-conversation-id` back, with a NEW `id`.**

```bash
curl -i -X POST https://<host>/api/chat \
  -H "content-type: application/json" \
  -H "cookie: llt_session=$COOKIE" \
  -d '{
        "conversationId": "22222222-2222-2222-2222-222222222222",
        "messages": [
          { "id": "p91xbn4vqe0st6cw", "role": "user",
            "parts": [{ "type": "text", "text": "Show me one in R." }] }
        ]
      }'
```

```
HTTP/1.1 200 OK
x-conversation-id: 22222222-2222-2222-2222-222222222222

data: {"type":"start"}
data: {"type":"start-step"}
data: {"type":"tool-input-available","toolCallId":"call-1","toolName":"executeRCode","input":{"code":"t.test(x)$p.value"}}
data: {"type":"tool-output-available","toolCallId":"call-1","output":{"status":"displayed","code":"t.test(x)$p.value"}}
data: {"type":"finish-step"}
data: {"type":"finish"}
data: [DONE]
```

Note the id changed (`kf83jd0alq72mzx1` → `p91xbn4vqe0st6cw`) while
`x-conversation-id` stayed the same. That is the whole protocol.

**Turn 2, re-sent verbatim — the id-reuse case (same id, same content).**

```bash
# byte-identical to the request above
curl -i -X POST https://<host>/api/chat \
  -H "content-type: application/json" \
  -H "cookie: llt_session=$COOKIE" \
  -d '{
        "conversationId": "22222222-2222-2222-2222-222222222222",
        "messages": [
          { "id": "p91xbn4vqe0st6cw", "role": "user",
            "parts": [{ "type": "text", "text": "Show me one in R." }] }
        ]
      }'
```

```
HTTP/1.1 200 OK
x-conversation-id: 22222222-2222-2222-2222-222222222222
x-replayed: true

data: {"type":"start"}
data: {"type":"start-step"}
data: {"type":"tool-input-available","toolCallId":"call-1","toolName":"executeRCode","input":{"code":"t.test(x)$p.value"}}
data: {"type":"tool-output-available","toolCallId":"call-1","output":{"status":"displayed","code":"t.test(x)$p.value"}}
data: {"type":"finish-step"}
data: {"type":"finish"}
data: [DONE]
```

Identical stream body, **no model call, no new database rows** — and
`x-replayed: true` is how you know. This is correct and intended: it makes a
lost-response retry safe.

**Turn 2, re-sent with the SAME id but DIFFERENT text — permanent conflict.**

```bash
curl -i -X POST https://<host>/api/chat \
  -H "content-type: application/json" \
  -H "cookie: llt_session=$COOKIE" \
  -d '{
        "conversationId": "22222222-2222-2222-2222-222222222222",
        "messages": [
          { "id": "p91xbn4vqe0st6cw", "role": "user",
            "parts": [{ "type": "text", "text": "Actually, show me in Python." }] }
        ]
      }'
```

```
HTTP/1.1 409 Conflict
content-type: application/json

{"error":"A message with this clientMessageId already exists with different content","code":"duplicate_message"}
```

Nothing was persisted, no model call was made, and re-sending will 409
identically forever. Fix it by generating a new `id`.

---

## Section-conversation routes

A **section conversation** is one student's (or one instructor's teacher-test)
run through a single homework section. At most one *active* conversation exists
per (section, user). All four routes require course membership; per-conversation
access is then checked inside the handler.

`POST /api/chat` with `kind: "section"` and a `sectionId` goes through the same
machinery as `POST .../sections/:sectionId/conversations`, so a conversation
started either way is identical — including the greeting written as its first
message.

### `POST /api/courses/:courseId/sections/:sectionId/conversations`

Start a section conversation.

**Auth:** session + membership of `:courseId`. A caller who is not enrolled as a
student in the course is recorded as a *teacher test* (`isTeacherTest: true`),
which makes the conversation non-submittable.

**Body:** none.

**201:**

```jsonc
{
  "id": "22222222-2222-2222-2222-222222222222",
  "title": "…",
  "greetingMessageId": "…",   // id of the greeting persisted as message seq 1
  "greetingParts": [ … ],     // the greeting's UIMessage parts (raw jsonb)
  "promptTemplateId": null    // string | null — the pinned prompt template
}
```

| Status | Body |
| --- | --- |
| 401 | `{"error":"Unauthorized"}` — no session |
| 403 | `{"error":"Course access denied"}` — not a member of `:courseId` |
| 404 | `{"error":"Section not found"}` — missing, malformed id, outside the course, or unreleased to you |
| 409 | `{"error":"An active conversation already exists for this section"}` — GET it instead |
| 409 | `{"error":"Section is not interactive and cannot hold a conversation"}` |

### `GET /api/courses/:courseId/sections/:sectionId/conversation`

Fetch the caller's own active conversation for a section, with a page of
messages.

| Param | In | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `limit` | query | integer 1–500 | 200 | |
| `before` | query | integer `seq` | — | Same seq-cursor semantics as `/api/conversations/:id/messages` |

**200** — and note that "you have not started this section" is a **200**, not a
404:

```jsonc
{
  "conversation": {
    "id": "…", "title": "…", "sectionId": "…",
    "isTeacherTest": false,
    "createdAt": "2026-08-01T00:00:00.000Z"
  },
  "messages": [
    { "id": "…", "role": "user", "parts": [ … ], "createdAt": "2026-08-01T00:00:01.000Z" }
  ]
}
```

```jsonc
// not started yet:
{ "conversation": null, "messages": [] }
```

Unlike `/api/conversations/:id/messages`, these message rows carry **no `seq`
field** even though `before` is a seq cursor.

| Status | Body |
| --- | --- |
| 400 | `{"error":"limit must be an integer between 1 and 500"}` |
| 400 | `{"error":"before must be an integer seq value"}` |
| 401 | `{"error":"Unauthorized"}` — no session |
| 403 | `{"error":"Course access denied"}` — not a member of `:courseId` |
| 404 | `{"error":"Section not found"}` — missing or malformed `sectionId` |
| 404 | `{"error":"Conversation not found"}` — the section is unreleased to you |

### `GET /api/courses/:courseId/conversations/:conversationId`

Fetch one section conversation by id. Readable by its owner **and** by graders
of the course (instructor / admin / TA) — with one exclusion: a grader may not
open another grader's teacher-test conversation.

Same `limit` / `before` params as above.

**200:**

```jsonc
{
  "conversation": {
    "id": "…", "title": "…", "sectionId": "…",
    "ownerUserId": "…",        // present here, unlike the active-conversation route
    "isTeacherTest": false,
    "isDeleted": false,
    "createdAt": "2026-08-01T00:00:00.000Z"
  },
  "messages": [ { "id": "…", "role": "…", "parts": [ … ], "createdAt": "…" } ]
}
```

| Status | Body |
| --- | --- |
| 400 | `{"error":"limit must be an integer between 1 and 500"}` / `{"error":"before must be an integer seq value"}` |
| 401 | `{"error":"Unauthorized"}` — no session |
| 403 | `{"error":"Course access denied"}` — not a member of `:courseId` |
| 404 | `{"error":"Conversation not found"}` — missing, malformed id, not readable by you, or its section is unreleased to you |

### `POST /api/courses/:courseId/conversations/:conversationId/restart`

Start over on a section. The existing conversation is closed and a new one is
created with a fresh greeting. **If an ungraded submission exists for the old
conversation, it is voided.**

**Auth:** session + membership; the caller must own the conversation.

**Body:** none.

**201:**

```jsonc
{
  "conversation": { "id": "…", "title": "…", "greetingMessageId": "…" },
  "voidedSubmission": { "id": "…", "submittedAt": "2026-08-01T00:00:00.000Z" }  // or null
}
```

| Status | Body |
| --- | --- |
| 401 | `{"error":"Unauthorized"}` — no session |
| 403 | `{"error":"Course access denied"}` — not a member of `:courseId`, or the course has no resolvable organization |
| 404 | `{"error":"Conversation not found"}` — missing, malformed id, or not yours |
| 409 | `{"error":"Submission has already been graded and cannot be restarted"}` |

---

## Submission

### `POST /api/conversations/:id/submit`

Submit the section conversation identified by `:id`. Student role only.

**Body:** none.

**201** on a first submission, **200** on a resubmission — same body either way:

```jsonc
{
  "id": "…",
  "conversationId": "…",
  "submittedAt": "2026-08-01T00:00:00.000Z",
  "isResubmission": false
}
```

| Status | Body |
| --- | --- |
| 403 | `{"error":"Insufficient permissions"}` — caller is not a student |
| 403 | `{"error":"No organization membership found"}` |
| 403 | `{"error":"Conversation not found or not accessible"}` — **403, not 404**; see the [conventions exception](#404-not-403-row-ownership-vs-403-course-scope). Covers both "not yours" and "not a submittable conversation". |
| 409 | `{"error":"Teacher test conversations cannot be submitted"}` |
| 409 | `{"error":"Homework is hidden or expired"}` |

---

## Known gaps

Current behavior, stated so you do not waste time deciding whether it is a bug
on your side:

1. **`POST /api/conversations/:id/submit` does not validate `:id` as a UUID.**
   Every other `:id` route rejects a malformed id with a 404 before touching the
   database. This one passes it through, so a malformed id surfaces as a generic
   `503 {"error":"Something went wrong. Please try again later."}` rather than a
   404. Send well-formed UUIDs.
2. **The messages page has no `nextCursor`.** Page by reading `seq` off the
   oldest row you received. On the section-conversation routes, message rows do
   not carry `seq` at all, so those routes are effectively single-page unless you
   track sequence numbers another way.
3. **A non-null `nextCursor` on `GET /api/conversations` does not guarantee more
   rows** — it means "the page was full," which is the only signal available.
4. **`x-conversation-id` is a header, not a body field**, because the body is a
   stream. There is no JSON alternative.
5. **`code` is only present on `/api/chat` responses.** Other routes give you a
   status and a sentence.
6. **No OpenAPI artifact.** This document is hand-maintained against the Zod
   schemas in the source files listed at the top; if you find a discrepancy, the
   code wins — please file an issue.
