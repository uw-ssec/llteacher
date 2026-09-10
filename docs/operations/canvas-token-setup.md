# Setting up Canvas roster sync (#73/#74)

This is the near-term Canvas integration path (decided 2026-07-28 — see
`docs/notes/transcript-2026-07-28.md`): institutional LTI/API access is
blocked on UW-IT/Instructure approvals until roughly September–October, so
an instructor generates their own Canvas API token and registers it here.
LTI 1.3 (automatic, no manual token) is future work, tracked separately.

## 1. Generate a Canvas API token

1. Log into Canvas and go to **Account → Settings**.
2. Scroll to **Approved Integrations** and click **+ New Access Token**.
3. Purpose: something identifiable, e.g. `llteacher roster sync`.
4. Expiry: Canvas defaults to no expiry. Set one — roughly a quarter out
   is the working convention here — so a token isn't silently valid
   forever if it's ever exposed. Canvas will warn you before it expires;
   the console's own "Validate" button (below) is the reliable way to
   check its current state.
5. Click **Generate Token** and copy it immediately — Canvas shows it
   exactly once.

The token carries **your own Canvas permissions**. For roster sync to see
a course's enrollments, you need to be an instructor (or otherwise
enrolled with visibility into the roster) on that course in Canvas. No
special admin-level Canvas role is required — this integration only ever
reads courses and enrollments your own account can already see
(`GET /api/v1/courses`, `GET /api/v1/courses/:id/enrollments`,
`GET /api/v1/users/self` for validation).

## 2. Register the token in the admin console

1. Open the admin console → **Canvas** (left sidebar, instructors only).
2. Under **Canvas API token**, enter:
   - **Canvas instance URL** — your institution's Canvas domain, e.g.
     `https://uw.instructure.com`. No trailing path.
   - **API token** — the value copied in step 1.
3. Click **Save token**.

The token is encrypted at rest (the same AES-256-GCM encryption this app
uses for student PII) and is never shown again in full — only masked
(first and last two characters) once saved.

## 3. Validate the token

Click **Validate**. This pings Canvas's own `/api/v1/users/self` endpoint
with the stored token — the cheapest real call that confirms the token
still works and reports back which Canvas account it belongs to. Run this
any time a sync starts failing with an authentication error.

## 4. Link a course

1. Under **Course roster sync**, click **Link a Canvas course**.
2. Pick the Canvas course from the list — this is every course your
   token's Canvas account is a teacher on.
3. Click **Link this course**.

Only one llteacher course can be linked to a given Canvas course at a
time; linking refuses with a clear message if another course already
claims it.

## 5. Sync the roster

Click **Sync from Canvas**. This is a manual, on-demand action — there is
currently no automatic/scheduled re-sync (a future enhancement, not built
in this pass). A sync:

- Adds anyone in the Canvas roster not yet on the llteacher course, as a
  **pending** account (they get full access the moment they first sign in
  through WorkOS SSO — no separate invite step).
- Updates the role of anyone whose Canvas role changed since the last
  sync.
- Soft-removes (not deletes) anyone who dropped the Canvas course. Their
  past submissions and grades are preserved; they simply lose active
  access. Re-adding them in Canvas and syncing again restores access.
- Reports, per row, anything it could not sync (e.g. a Canvas enrollment
  with no email on file, or a person already manually added to the course
  under a different role than Canvas now reports — that one is left for
  you to resolve by hand rather than auto-overridden).

Re-running a sync is always safe — it's idempotent. Running it twice in a
row with no Canvas-side changes reports zero additions.

## Canvas role mapping

| Canvas role | llteacher role |
|---|---|
| Teacher | Instructor |
| TA | TA |
| Student | Student |
| Observer | Observer |
| Designer | Instructor (closest available — no direct equivalent) |

## Troubleshooting

- **"Canvas rejected this token"** — it expired or was revoked. Generate a
  new one (step 1) and use **Replace token**.
- **"Another course in your organization is already linked to that Canvas
  course"** — check with whoever set up that other course; a Canvas
  course can only feed one llteacher course.
- **A sync reports errors for specific rows** — these are per-enrollment
  problems (missing email, an unrecognized Canvas role, a genuine role
  conflict against someone already manually added). They don't fail the
  whole sync; everyone else still syncs normally.

## Scope of this integration

Grade passback to Canvas is explicitly out of scope, both now and for the
future LTI path — use the export feature to get grades out of llteacher.
