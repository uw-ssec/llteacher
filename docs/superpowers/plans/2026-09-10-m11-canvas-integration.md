# M11: Canvas Integration — Implementation Plan

## 2026-09-15 sync check — the remaining review findings (items 10/13, usability/accessibility Major list)

Follow-up to the entry directly below: user asked for the deferred items
too. Covers item #10 (duplicate-enrollment dedup), item #13
(`apiCredentialId` unused), and the usability/accessibility Major list's
enumerated items (the unenumerated Minor/Enhancement tier -- ~15 more
per agent, never itemized in this doc -- is still not covered; a fresh
pass would be needed to extract it).

10. **Duplicate Canvas enrollments (multi-section) no longer permanently
    break.** `CanvasRosterSyncService.ts`: entries are deduplicated by
    email BEFORE the known/new split (not just within one sync's "new"
    set, which only fixed the first-sync case) -- the highest-authority
    role among duplicates wins, chosen consistently across syncs since
    role authority doesn't change sync to sync, so the same
    canvasEnrollmentId converges as "known" every time. The loser is
    dropped silently, never reaching either write pass, so it can never
    produce a recurring role-conflict error. Covered by a new test
    spanning two sync runs.
13. **`apiCredentialId` unused-field trap documented, not built out.**
    Building real per-link credential resolution would be speculative
    engineering against a feature (multi-credential-per-org) that
    doesn't exist and isn't planned -- `organizationCredentials.ts`'s own
    header is explicit that exactly one Canvas credential per org is the
    deliberate v0 design. Instead, `identity.ts`'s own column comment now
    states plainly that this field is written but not currently consulted
    by credential resolution, and what would need to change if
    multi-credential support is ever added -- so a future reader doesn't
    assume it's already load-bearing.

**Usability/accessibility Major items** (all traced back to a handful of
root causes, as the original review predicted):

- **Raw `role_conflict` leak fixed at the source.** `CanvasRosterSyncService.ts`
  gained `friendlyProvisionMessage` -- `role_conflict` results now name
  the existing role and suggest a manual fix, instead of leaking the raw
  ProvisionStatus enum value into instructor-facing copy.
- **Linked course now shows its name, not just a raw Canvas id.** New
  `courses.canvas_course_name` column (migration `0048`), populated at
  link time from the same `listCanvasCourses()` result #3's cross-check
  already fetches -- no extra Canvas call. Falls back to the id alone for
  a course linked before this column existed.
- **A failed credential load offers Retry, not the blank entry form.**
  New `credentialLoadFailed` state keeps `credential` genuinely unknown
  on a load failure instead of collapsing to `null` (which this view's
  own render logic read as "no token on file").
- **Six buttons no longer `disabled` while in flight** (ACC-002): each
  in-flight boolean is now a re-entry guard inside its own handler
  (`if (saving) { announce(...); return; }`) instead of `disabled` on the
  button, matching TaCapabilitiesView's own established fix for the same
  lesson (disabling a focused control blurs it and drops a keyboard
  user). `runSync`'s guard is defense-in-depth on top of #6's real,
  server-side atomic claim.
- **Focus restored across six teardown paths** (ACC-020): a single
  `focusTargetRef` + one no-dependency-array effect (mirrors
  TaCapabilitiesView's per-row `restoreFocusTo`, simplified for this
  view's single-target shape) -- Replace/Cancel/Save/Delete/Link/Cancel
  each name where focus should land before the transition that would
  otherwise drop it to `<body>`.
- **No more conditionally-mounted `role="alert"`/`role="status"` banners**
  (ACC-004), and no more double-announcing the same event on two channels
  (ACC-025): every banner that used to carry a role now carries none,
  relying solely on the one always-mounted live region -- matching
  TaCapabilitiesView's own already-established fix for the identical
  defect (its `loadError` banner already omits `role` for the same
  reason).
- **Field-level `aria-invalid`/`aria-errormessage` now wired up** (ACC-003):
  a small heuristic (`fieldForCredentialError`) matches this form's fixed,
  known validation sentences to the field they're about, activating the
  `input[aria-invalid="true"]` CSS rule that already existed in
  `styles.css` and was unused by this view. `aria-describedby` carries
  both the hint id and the error id together, not one or the other --
  VoiceOver doesn't implement `aria-errormessage` alone.
- **Token validated automatically right after save**, not left for the
  instructor to remember (fire-and-forget, doesn't block the save
  itself completing).
- **Removal confirmation now states the org-wide blast radius, what's
  preserved, and the undo path** -- matching every sibling confirm
  dialog in this codebase (StudentsView/TaCapabilitiesView's own
  convention).
- **A real, separate bug caught while fixing ACC-002**:
  `savingCredential` was set true but never reset to false anywhere in
  the original code -- the Save button stuck on "Saving…" forever after
  the first save attempt. Fixed with a `finally` block; covered by a
  regression test (save once, reopen the form, confirm the button reads
  "Save token" again).
- **New WCAG 1.4.11 contrast fix**: a dedicated `--color-input-border`
  token (light `#847E72` @ 3.51:1, dark `#7C766C` @ 3.54:1, both
  precisely computed against `--color-surface`) replaces `--color-border`
  (1.14:1) on every `.admin-form-field`/`.admin-form-record` input --
  fixes the regression the same session's earlier CSS border fix
  introduced, per the review's own recommendation ("a dedicated
  input-boundary token... not a revert").

**Not done, deliberately**: the Minor/Enhancement tier (~15 more items
per agent -- expiry-date timezone off-by-one, a stray missing hint id,
loading-state noun choices, etc.) was never itemized in this doc, only
described as existing in the review agents' own transcripts. Extracting
and fixing that tier would need a fresh pass, not a continuation of this
one.

**Verification**: `npm run typecheck` clean across all 4 packages;
`apps/web`'s full suite -- 105 files / 2000 passed / 8 skipped (Docker
Postgres, freshly migrated including 0047 and 0048); `apps/admin`'s full
suite -- 22 files / 265 passed. `CanvasIntegrationView.test.tsx` alone
grew from 12 to 19 cases covering every behavioral change above.
Migrations 0047 and 0048 applied to both the local test Postgres and the
shared dev DB (the same scratch-single-migration approach as 0046, since
that DB's full sequence has known pre-existing drift). **Not verified
live in a browser**: this session has no WorkOS login credentials to
reach the authenticated admin console, so the visual/interactive
behavior (focus movement, the Retry button, the field-error styling) is
confirmed only by the component test suite (jsdom + Testing Library,
which does assert real DOM/ARIA attributes) and by hand-computed
contrast ratios, not by an actual rendered screenshot. Both dev servers
are running for the user's own manual check.

## 2026-09-15 sync check — fixes for the 11-dimension review's blocking/critical findings

User request: fix everything the review below found. Fixed all 5 of
security's own merge-gate items (1-5) and all 4 of the "also
Critical/Major, load-bearing" items (6-9) -- the exact set the review's
own "Recommended next step" named as the real blocking scope. Left for a
deliberate follow-up (not started): item #10 (duplicate-enrollment
dedup), item #13 (`apiCredentialId` unused), and the extensive
usability/accessibility Major list -- all explicitly flagged "not
blocking" by the review itself, and the review's own closing line
suggested asking before a full pass on the Minor/Enhancement tier; the
same judgment extended here to the larger Major-tier UI work rather than
rushing it in the same pass as the security fixes.

1. **Pagination token-exfiltration** — `fetchAllPages` (`canvas-api.ts`)
   now locks every page after the first to the origin of the request that
   started the fetch, and throws rather than following an off-origin
   `Link` header; a 500-page defensive bound added alongside it. Covered
   by a new test asserting a cross-origin `next` link is refused and
   fetch is called exactly once.
2. **SSRF via unvalidated Canvas base URL** — `parseCanvasBaseUrl`
   (`canvasCredentials.ts`) now rejects `localhost`, `.local`/`.internal`
   suffixes, IPv4/IPv6 literals, and single-label hosts, as a best-effort
   defense-in-depth filter (this environment has no DNS-resolution
   capability to check where a hostname actually resolves; fix #1's
   same-origin pagination lock is the load-bearing mitigation for the
   actual request boundary). Six disallowed-host cases + one real-domain
   acceptance case added to `canvasCredentials.test.ts`.
3. **Cross-instructor roster disclosure** — `linkCanvasCourseHandler`
   (`canvasSync.ts`) now cross-checks the submitted `canvasCourseId`
   against the org's own token's `listCanvasCourses()` result before
   linking, refusing with 403 if it isn't one the token's owner actually
   teaches. Covered by a new test.
4. **Role-grant ratchet** — Pass A's grouped update (see #8 below) now
   clears `canViewSolutions`/`canViewDrafts` whenever the incoming role
   isn't `ta`, closing the exact gap the DB's own
   `course_memberships_capabilities_require_ta` constraint was written to
   catch. Covered by a new test: syncs a TA, manually grants both flags,
   demotes via a re-sync, asserts both are cleared and no error is
   reported.
5. **`canvasEnrollmentId` uniqueness was table-global** — rescoped to
   `(course_id, canvas_enrollment_id)` via new migration
   `0047_canvas_enrollment_uq_per_course.sql`. Safe by construction (a
   narrower scope can only reduce conflicts, never introduce new ones).
   Applied to the local test Postgres via the normal `db:migrate`, and to
   the shared dev DB via the same scratch-single-migration approach used
   for 0046 (that DB's full migration sequence has known pre-existing
   drift, documented in this plan's 2026-09-14 entry below) — confirmed
   via `pg_indexes` before and after.
6. **No concurrency guard on sync** — added `beginSync`
   (`lmsIntegrations.ts`): an atomic `UPDATE ... WHERE lastSyncStatus !=
   'syncing' OR updatedAt < now() - 10min` claim, called at the top of
   `syncCanvasCourseHandler` before any fetch or write; returns 409 "A
   sync for this course is already running" if the claim fails. The
   10-minute staleness escape hatch handles an isolate killed mid-sync
   without needing a heartbeat mechanism this feature doesn't otherwise
   warrant. Covered by a new test.
7. **Silent sync/link/delete failures** — every catch in
   `CanvasIntegrationView.tsx` that previously called only `announce()`
   (the screen-reader-only live region) on a non-abort failure now also
   sets a visible error: `runSync` gained a dedicated `syncError` state
   rendered as an `admin-alert`, with a distinct message when the failure
   is specifically a client-side timeout (`err.name === "TimeoutError"`,
   `abortAfter.ts`'s own distinguishing reason) versus a genuine
   component-unmount abort (`"AbortError"`, correctly still suppressed).
   `linkCourse` and `deleteCredential` now reuse their existing
   `courseOptionsError`/`credentialError` banners the same way. Covered
   by a new test asserting a failed sync request renders a `role="alert"`
   element, not just an announcement.
8. **Sequential per-row DB writes (issue #355's pattern, reintroduced)** —
   Pass A's known-row updates are now grouped by `(role, canvasRole)` and
   written in at most a handful of statements (mirrors `roster.ts`'s own
   `restoresByRole` pattern) instead of one UPDATE per student. Pass B's
   Canvas-identity stamp is now threaded directly into
   `upsertCourseMembers`' own batched INSERT (`roster.ts`'s
   `ProvisionEntry` gained optional `canvasEnrollmentId`/`canvasRole`
   fields) for the dominant "added" case, leaving only the much smaller
   "restored"/"already_enrolled" subset as a residual per-row loop. Pass
   C was already a single batched UPDATE and is unchanged.
9. **Parsing-gap mass-drop reported as success** — Pass C's removal diff
   now excludes based on every enrollment THIS sync actually fetched
   (`enrollments`), not just the ones that parsed cleanly (`mapped`), so
   a row that fails to map (unmapped role, missing email) is reported as
   a per-row error without also being read as "no longer enrolled" and
   soft-dropped. Covered by a new test: syncs an enrollment, re-syncs
   with that same enrollment now missing its email, asserts it's NOT
   removed.

Also fixed as directly-named root causes of the above (compatibility
review's #11/#12, cited by security's own #9 writeup):
- `isRateLimited` (`canvas-api.ts`) now also matches Canvas's real/current
  429 rate-limit status (was 403-only, dead against any modern Canvas
  instance); `canvasErrorMessage` (`canvasSync.ts`) and the validate
  handler (`canvasCredentials.ts`) now give `CanvasRateLimitedError` its
  own message instead of folding it into "token rejected."
- `listCanvasEnrollments` now requests `include[]=email` and prefers
  `user.email` over `user.login_id`, only falling back to `login_id` when
  it's actually shaped like an email — at NetID institutions (UW, this
  app's target deployment) `login_id` is a bare login name, not an email,
  and silently using it as one produced a value that failed every
  downstream domain check instead of a clear "no email on file."

**Verification**: `npm run typecheck` clean across all 4 packages;
`apps/web`'s full suite (Docker Postgres, freshly migrated) — 105
files / 1999 passed / 8 skipped (the 8 are pre-existing and unrelated);
`apps/admin`'s full suite — 22 files / 257 passed. 14 new/updated test
cases across `canvas-api.test.ts`, `CanvasRosterSyncService.test.ts`,
`canvasCredentials.test.ts`, `canvasSync.test.ts`, and
`CanvasIntegrationView.test.tsx` covering every fix above.

Not yet re-run: the full 11-dimension review itself. These fixes were
scoped tightly to the findings as written, not re-audited fresh — worth
a targeted re-check of items 1-9 (not a full 11-agent re-run) before
merge, given how easy it is for a fix this size to introduce something
new.

## 2026-09-14/15 sync check — 11-dimension review of PR #457, verdict: HOLD

Full multi-agent review against PR #457's diff, following this project's
established 11-dimension methodology (security/functionality/reliability/
maintainability/performance/scalability/compatibility/flexibility/
usability/accessibility — security examined first and last): 10 parallel
single-dimension audits, then a dedicated final security re-pass over the
other 9 dimensions' findings plus the diff itself. Two live UI/UX fixes
(a corrected example Canvas URL — `https://canvas.uw.edu`, confirmed via
search, not the placeholder `uw.instructure.com` originally used; and a
CSS fix for password/url/date inputs that rendered with no visible
border) landed mid-review in response to real user testing and were
folded into the later passes' context.

**Verdict from the final security pass, which had the full picture: HOLD
— do not merge as-is.** Not a reversal of the first security pass; the
cross-cutting view sharpened it. The defects concentrate at one coherent
boundary — everywhere this app trusts data it received *from* Canvas
(a URL in a `Link` header, a `canvasCourseId` in a request body, an
enrollment type, an enrollment id) — which is a fixable theme, not a
diffuse quality problem. Everything else audited as genuinely clean:
encryption/IV handling, token masking, org-scoping on every query, CSRF,
SQLi, the exactly-one-secret-shape DB constraint.

### Blocking (security's own merge gate — fix before merge)

1. **Pagination token-exfiltration primitive.** `lib/canvas-api.ts:125-174`
   — `fetchAllPages` follows the `Link` header's `rel="next"` URL
   *verbatim*, bearer token attached, to any origin, with no page bound.
   This is not a redirect (where the platform would strip the
   `Authorization` header) — it's a fresh `fetch()` the code makes itself.
   A malicious/compromised second page hands the org-wide Canvas token to
   any host the response names. **Closes finding #2 below too** — fixing
   this to same-origin-only also bounds the SSRF blast radius.
2. **SSRF via unvalidated Canvas base URL.** `routes/canvasCredentials.ts:54-73`
   (`parseCanvasBaseUrl`) checks scheme (https) and path (none) but never
   the host — no allowlist, no private/link-local/loopback rejection.
   `validateCanvasToken`/`listCanvasCourses` reflect response fields back
   to the caller, so this doubles as an internal port/host scanner
   (status + latency differentiate reachability). Needs an org-configured
   allowlist, not a hardcoded `*.instructure.com` check — `canvas.uw.edu`
   itself is a vanity domain, proof institutions don't all live on one
   hostname pattern.
3. **Cross-instructor roster disclosure.** `routes/canvasSync.ts:100-111`
   — `linkCanvasCourseHandler` accepts `canvasCourseId` from the request
   body with no check that it's one of the courses the org's *stored*
   token can actually see. Combined with the credential being org-wide:
   instructor B (any course, same org) can link to a Canvas course
   instructor A teaches, sync pulls A's students' names/emails onto B's
   course, which B can then read. Fix: verify against `listCanvasCourses`'
   own result before linking.
4. **Role-grant ratchet: escalation succeeds, revocation silently fails.**
   `lib/services/CanvasRosterSyncService.ts:129-145` (Pass A) — the
   known-row role update never clears `canViewSolutions`/`canViewDrafts`,
   unlike every other role/restore write in the codebase (`roster.ts`,
   `UserIdentityService.ts`, `users.ts` all clear them). The DB's own
   `course_memberships_capabilities_require_ta` check constraint
   (`identity.ts:320-323`) — written, per its own comment, *specifically*
   to catch "the future role-change path" that "cannot forget" this —
   catches the violation on **demotion** (TA→student with a live grant)
   and throws, which Pass A swallows into the per-row error array while
   the sync reports `"success"`. A demoted TA keeps the answer-key grant
   indefinitely. Promotion (student→instructor) hits no such constraint
   and sails through. Same block also needs the restore scoped to
   `droppedReason = "roster_removal"` (see #6) — both are 1-2 line fixes
   in the same `.set()` call.
5. **`canvasEnrollmentId` uniqueness is table-global, not per-tenant.**
   `course_memberships_canvas_enrollment_uq` (`identity.ts:295-297`,
   from migration `0000`) has no `course_id`/`organization_id` scope.
   Two organizations on two different Canvas instances (`canvas.uw.edu`
   vs. any other institution) draw enrollment ids from the same small
   integer space — collision is near-certain at scale, not theoretical.
   This PR is the *first* code that ever writes this column, so it's
   what makes the pre-existing index reachable. One org's data volume can
   permanently and unresolvably fail another org's sync for the colliding
   student (availability/integrity, not disclosure — the course-scoped
   `knownByCanvasId` lookup is correct). Needs a migration to rescope the
   index to `(organization_id, canvas_enrollment_id)`.

### Also Critical/Major (not in security's own gate, but load-bearing — fix in the same pass)

6. **No concurrency guard on sync, and the DB records reads confirm it's reachable.**
   Reliability, Critical. `lms_sync_status`'s `'syncing'` value is defined
   (`identity.ts:86`) and never written anywhere — no advisory lock, no
   precondition check. Pass C (`CanvasRosterSyncService.ts:193-230`) reads
   *live* DB state after an arbitrarily long fetch+write window but acts
   on an `incomingIdSet` snapshot taken *before* that window — so two
   overlapping sync runs on one course can have the earlier run's Pass C
   soft-drop a student the later run just added and who is actually
   currently enrolled. Security's read: not exploitable cross-course (an
   instructor can only race their own course), but it is a real audit-
   evasion gap — the outcome is indistinguishable from a legitimate Canvas
   drop, no per-user attribution, and (given #9 just below) alarmingly
   easy to trigger by accident.
7. **The one thing standing between "accident" and "routine occurrence" for #6: sync failures are silent to the user.**
   Usability/Reliability, Critical. `CanvasIntegrationView.tsx`'s sync
   timeout (60s) aborts the *client* fetch only — the server-side sync
   keeps running. The catch path (`~:315-320`) calls `announce()` into the
   screen-reader-only live region and nothing else: no visible error, no
   `setSyncResult`, no status refresh. A sighted instructor sees the
   button flip back to "Sync from Canvas" with zero signal anything
   happened, and the only reasonable next move is to click it again —
   which is precisely what reproduces #6. Same silent-catch shape exists
   on Validate and Link. Security's assessment: this UX gap is the
   *primary realistic trigger* for the concurrency race, not just an
   annoyance next to it.
8. **Sequential per-row DB writes reintroduce a defect this codebase already fixed once (issue #355).**
   Performance/Functionality/Scalability/Compatibility, Critical (4-way
   cross-confirmed). `CanvasRosterSyncService.ts`'s Pass A (`:126-145`)
   and Pass B (`:161-190`) each issue one individual `db.update()` per
   enrolled student in a sequential loop — exactly the shape `roster.ts`'s
   own header comment says a prior CSV-import incident (#355) was fixed
   to eliminate ("~900 [queries] for 300 rows... exceeded both the cap
   and the wall clock, leaving a half-written roster"). Measured: ~300
   round trips at 300 students, exceeding the Workers free-tier cap
   (50) at ~42 students and this repo's own 900-subrequest budget
   (`autoSubmitOverdue.ts`) at ~890. Security's addition: when the isolate
   is killed mid-loop, Pass A's already-committed role writes have no
   accompanying audit event (`auditLmsChange` runs after, at the very
   end) and `lastSyncStatus` keeps showing the *previous* run's
   `"success"` — so this isn't just slow, it's FERPA-relevant roster
   mutation with an actively misleading status and zero audit trail, and
   it's deterministic at ordinary course sizes, not rare. Fix (given by
   Performance, matches `roster.ts`'s own `restoresByRole` pattern):
   group Pass A's writes by `(role, canvasRole)` — ≤5 statements
   regardless of course size; thread the Canvas stamp into
   `upsertCourseMembers`'s own write for Pass B. Takes a 2,000-student
   sync from ~2,028 subrequests to ~35.
9. **A parsing gap can soft-drop most or all of a roster while reporting `"success"`.**
   Functionality, Critical. Any enrollment the sync can't interpret
   (unmapped Canvas role type, missing email) is filtered out *before*
   `incomingIdSet` is built (`CanvasRosterSyncService.ts:87-110`), so
   Pass C's removal diff (`:202-230`) reads it as "no longer enrolled,"
   not "couldn't parse." Concretely: if Canvas ever stops returning
   `login_id` on the enrollment's embedded user (a real, version-
   dependent field per Compatibility's finding #12 below — it isn't
   even a documented field of that object), every row fails to map,
   `mapped` is empty, and Pass C drops the *entire* previously-synced
   roster in one sync, reported as success. Security's read: not
   realistically attacker-triggerable (requires Canvas-side rights that
   already grant direct removal), but it fails open and silent — a
   sanity bound (refuse/flag Pass C if `removed` exceeds some fraction
   of the roster, or if any row failed to parse) is the right guard and
   would also blunt #6.

### Also worth knowing before merging (Major, not blocking)

10. **Duplicate Canvas enrollments for one person (multi-section — routine, not an edge case) permanently break, not just flap.**
    Functionality/Flexibility. Two enrollments, same email, different
    `canvasEnrollmentId`s → the stamping loop overwrites one id with the
    other on every sync (last-write-wins), and if the two enrollments
    carry different roles (Student + TA is the common case), the loser's
    re-sync hits `upsertCourseMembers`' deliberate role-conflict refusal
    every single time going forward — an unresolvable, un-actionable
    per-row error the instructor sees on every future sync with no fix
    available to them. Needs de-duplication by email before Pass B.
11. **Canvas's rate-limit signal moved from 403 to 429 years ago; this app's backoff only checks for 403.**
    Compatibility. `isRateLimited` (`canvas-api.ts:80-85`) never matches
    on a real/current Canvas instance, so the whole backoff/retry
    mechanism (and `CanvasRateLimitedError`) is dead code today — every
    rate-limited request throws a generic, unretried `CanvasApiError`
    mid-pagination. Fix both the detection and the route-layer mapping
    together (Flexibility separately found the route never distinguishes
    `CanvasRateLimitedError` from a generic 403 — currently moot since
    it's unreachable, but would become a live bug the moment 429-
    detection is added without also fixing the mapping).
12. **`login_id` is not a documented field of the enrollment's embedded user object,** and where present is a NetID-style login name, not an email, at NetID institutions (UW is the target deployment). Compatibility. Root cause of #9's most likely real-world trigger.
13. **`lms_integrations.apiCredentialId` is written and never read** — every credential resolution goes straight to the org-wide singleton by fixed label, ignoring which credential a specific course-link actually recorded. Flexibility/Security. Not cross-tenant-unsafe today (the singleton lookup is itself org-scoped), but a rotated token silently re-authorizes every dormant course link with no confirmation, and it's exactly the kind of write-and-ignore field that becomes a real confusion bug the moment a second credential per org is ever added.

### Usability/Accessibility — extensive, not merge-blocking on security grounds but real regressions against this codebase's own established bar

Both reviews graded against `TaCapabilitiesView.tsx`/`StudentsView.tsx`,
which have been through multiple real remediation passes documented in
their own code comments (the "ACC-NNN"/"USE-NNN" convention). Highest-
value items:

- **No visible error on sync/validate/link timeout or failure** (Usability
  Critical, same defect as #7 above, also present on Validate/Link).
- **A failed *load* renders as "no token on file"** and the recovery path
  offered is destructive — re-entering the token — for what's usually a
  transient network blip on an org-wide credential (Usability, Major).
- **No focus management across six teardown paths** — repeat of this
  codebase's own documented ACC-020 lesson; a keyboard/screen-reader user
  loses their place to `<body>` on Replace/Cancel/Save/Delete/Link/Cancel
  (Accessibility, Critical).
- **Six buttons `disabled` while in flight** — repeat of the documented
  ACC-002 lesson (disabling a focused control blurs it and drops a
  keyboard user); the established fix in this codebase is a re-entry
  guard, not `disabled` (Accessibility, Major).
- **Four of the six error/status regions are conditionally-mounted
  `role="alert"`/`role="status"`** — repeat of the documented ACC-004
  lesson (a region inserted already containing its text doesn't reliably
  announce); several also double-announce via both the region and
  `announce()` (repeat of ACC-025) (Accessibility, Major).
- **No `aria-invalid`/`aria-errormessage` field association anywhere** —
  every validation error surfaces in a page-level banner instead of next
  to the field that caused it, the exact case this codebase's own
  ACC-003 fix (cited in `styles.css`'s own comments) exists to prevent;
  the CSS rule for it is present and unused in this view (Accessibility,
  Major).
- **The sync result — the actual point of the feature — renders as the
  quietest, smallest text on the page**, with unidentified rows (no
  student name attached to a failure) and at least one raw internal
  value leaking through (`Could not enroll jane@uw.edu (role_conflict).`,
  since that repository result carries no message field) (Usability,
  Major). This repo already has the right pattern one file away
  (`RosterImportPanel.tsx`'s tone-and-copy table for the same
  `ProvisionStatus` values) — reuse it rather than rendering raw.
- **The linked course displays as a raw numeric Canvas ID** with no name,
  so an instructor teaching two sections can't verify which one they
  linked without re-opening the picker (Usability, Major).
- **Nothing prompts validation after save, and an invalid token "saves
  successfully"** with no on-card indication it was never verified
  (Usability, Major).
- **The org-wide blast radius of removing the token is never stated**,
  and the confirm dialog is generic where every sibling confirm dialog in
  this codebase names the subject, states the consequence, states what's
  preserved, and states the undo path (Usability, Major).
- **A new WCAG 1.4.11 contrast failure**, introduced by today's own CSS
  fix: the border color the fix correctly applied (`--color-border`) is
  the same token already used for `text`/`select`/`textarea` and already
  fails 3:1 there — but for `password`/`url`/`date` specifically this is
  a *regression*, since those fields previously fell through to the
  browser's default border (~4.3:1, passing). The right fix is a
  dedicated input-boundary token across the whole `.admin-form-field`
  rule, not a revert (Accessibility, Major).
- Full lists (Minor/Enhancement tier, ~15 more items each) are in the two
  agents' own transcripts — expiry-date off-by-one-day rendering
  (timezone), a stray missing hint id on two of three form fields, no
  loading-state noun, etc. Not reproduced here; ask if a full itemized
  pass is wanted before fixing.

### Maintainability findings worth carrying forward (Major, not merge-blocking)

- Pass A's restore comment claims a `droppedReason` scoping it doesn't
  implement (the same defect as blocking item #4/#6 above, independently
  caught by a different lens).
- Pass C duplicates `removeCourseMember`'s drop write field-for-field but
  silently omits its instructor/admin removal guard, with no comment
  saying that's deliberate.
- Seven of nine new wire types (`shared/types.ts` + `packages/ui/src/api/types.ts`)
  are declared, exported, and never imported anywhere — inert
  documentation that can't drift-detect, unlike this repo's own
  convention of binding response types at the return site.
- Three hand-written copies of the `lms_sync_status` vocabulary (schema
  enum, two TS unions) with no parity test, unlike `course_role`'s own
  `courseRoleParity.test.ts` guarding the identical shape of problem.
- `orgScopeForInstructor`-equivalent authority→scope translation now
  exists in three places (`llmConfigs.ts`, `canvasCredentials.ts`,
  `canvasSync.ts`), two of them stripped of the original's explanatory
  comment.

### Recommended next step

Security's own merge gate (items 1-5 above) plus items 6-9 are the real
blocking set — all five of security's items are narrow (1-2 line fixes
for #4, a same-origin+page-bound check for #1/#2, a `listCanvasCourses`
cross-check for #3, one migration for #5). Items 6-9 share a root cause
(#8's batching fix) or are cheap (#6/#7's status-write + visible-error
pair). Recommend fixing all nine in this same PR before merge, plus the
highest-value usability/accessibility items (visible error states,
focus management, the field-error association), given how much of the
usability/accessibility list traces back to the same few root causes
(silent catches, six unguarded teardowns) rather than being 30
independent problems.

## 2026-09-14 sync check (end-to-end provisioning verification, post-PR-open)

User request after PR #457 was open and reviewer-requested: prove the
full instructor-facing flow works — token entry through to real
database rows for students (name/email) and course memberships, and
the WorkOS reconciliation half. Clarified scope first rather than
guessing (AskUserQuestion): confirmed "provisioned in WorkOS" means the
already-built pending-user design (Design decision #3), not new
active-WorkOS-API scope; confirmed mocked Canvas responses over a real
account; confirmed the local disposable Postgres over the shared dev DB.

Added `routes/canvasProvisioning.integration.test.ts`: drives the REAL
route handlers, REAL repositories, and REAL IdentityCipher (genuine
AES-256-GCM round-trips, not mocked crypto) against the local Postgres,
substituting only the Canvas HTTP boundary — same fidelity posture
`chat.fallback.integration.test.ts` documents for its own single
substituted boundary. Covers token save (asserts the raw token never
appears in any HTTP response) → validate → course picker → link →
sync → real `course_memberships`/`users` rows with correctly
decrypted name/email and the right role per Canvas enrollment type →
sync status + full audit trail → a simulated real first login
(`UserIdentityService.createOrClaimUser`, the exact call site
`auth.ts`'s callback handler makes) claiming the pending row → a second
sync proving idempotency.

**A genuinely useful escaped-bug hunt, twice over, during this pass**:
1. Two test-fixture bugs (not product bugs) surfaced by real
   constraints: a non-UUID `session.userId` silently tripped
   `auditBestEffort`'s own swallow-and-log path (by design — a broken
   audit write must never break the request it's auditing), and a
   missing `users` row for the fake instructor hit
   `audit_events`'s real FK. Both fixed in the fixture.
2. A harder one: repeated manual runs against this file's *persistent*
   local Postgres intermittently threw a generic WebCrypto
   `OperationError: Cipher job failed` deep inside
   `UserIdentityService.createOrClaimUser`. Bisected by instrumenting
   (temporarily, not committed) both the test and
   `UserIdentityService.ts` line-by-line — traced to `byWorkosId`
   genuinely matching a row, which turned out to be a **leftover row
   from an earlier debug run**: one fixture literal
   (`"workos-user-ada-real-login"`) was never namespaced, so it
   collided with a stale row encrypted under that earlier run's own
   random `ENCRYPTION_KEY` — decrypting it under *this* run's key then
   fails exactly the way a wrong key should (a real AES-GCM auth-tag
   mismatch), surfaced as that generic error. Confirms
   `courseMemberships.canvasEnrollmentId`, `users.email_blind_index`,
   and `users.workos_user_id` are genuinely globally unique in
   practice, not just in the schema DDL — the same lesson
   `CanvasRosterSyncService.test.ts`'s own header already records, now
   hit a second time in a different file. Fixed by namespacing every
   fixture identifier with a fresh UUID per run; verified safe by
   running the file twice in a row against the same unreset database.

Final verification: `npm run typecheck` clean across all 4 packages;
full `apps/web` suite from a **freshly re-applied migration set** (schema
dropped and recreated, not just re-run against leftover state) —
**105 files / 1985 passed / 8 skipped**.

## 2026-09-10 sync check (implementation + epic acceptance pass, pre-PR)

Implemented inline, all in this one session, in the order this doc lays
out below. Full verification before opening the PR: `npm run typecheck`
clean across all 4 packages; `npx vitest run --testTimeout=30000` from
`apps/web` against the local Docker Postgres (`llteacher-test-pg`) with
every migration re-applied from a dropped schema — 104 files / 1984
passed / 8 skipped (pre-existing, unrelated); `apps/admin`'s own suite —
22 files / 257 passed. No live Canvas account was available in this
environment, so the Canvas HTTP layer is exercised only against a mocked
`fetch` (`canvas-api.test.ts`) and mocked `listCanvasEnrollments`
(`CanvasRosterSyncService.test.ts`, against a real Postgres) -- flagged
explicitly, not silently assumed equivalent to a live-Canvas check.

One real defect caught by the DB-gated sync-service tests, not by design
review: `course_memberships_canvas_enrollment_uq` is a GLOBAL unique
index (mirroring Canvas's own platform-wide enrollment ids), not scoped
per course -- an early version of the test fixtures reused literal
`"e1"`/`"e2"` ids across independent test cases and collided for real
against that constraint. Fixed in the tests (a per-test id namespace),
not the service -- the service's behavior on that failure (report a
per-row error, don't fail the whole sync) was already correct.

**Epic #61 acceptance checklist**, re-read against the real code rather
than assumed from this plan's own intent:
- [x] An instructor registers their Canvas token (encrypted, masked,
      auditable) and links a Canvas course
- [x] "Sync from Canvas" populates the roster with pending users who
      claim accounts via WorkOS SSO on first login (reuses roster.ts's
      existing pending-user path -- Design decision #3)
- [x] Re-sync is idempotent; removals and role changes are reflected
      without deleting rows
- [x] A runbook documents token generation, scopes, and quarterly
      refresh (`docs/operations/canvas-token-setup.md`)

Deliberately NOT built, per this plan's own scope boundaries: LTI 1.3
(#58-#60, explicitly deferred by the epic itself), a scheduled/automatic
re-sync (the epic names it optional; this PR ships the manual trigger
only, noted in the runbook), general course-creation UI (course linking
assumes the llteacher course already exists), and WorkOS bulk-invite API
calls (superseded by the reuse decision above).

Two gaps found and fixed during this same pass, before opening the PR:
the admin form collected `expiresAt` but never displayed it or warned
near expiry (#73's own "show expiry state" requirement), and every
token save audited as `credential.canvas_token_set` even on a
replacement. Both fixed with matching test coverage rather than left for
review to catch.

> **For agentic workers:** Implemented **inline in one session**, not via
> subagent-driven-development (explicit user choice for this milestone).
> Scope: GitHub milestone 11 (`M11: Canvas Integration`), issues
> [#73](https://github.com/uw-ssec/llteacher/issues/73),
> [#74](https://github.com/uw-ssec/llteacher/issues/74), epic
> [#61](https://github.com/uw-ssec/llteacher/issues/61). One cohesive PR
> against `staging` (the milestone is two closely-coupled issues, not the
> 20+-issue scale M4's 4-PR split existed to manage).

## 2026-09-10: stack correction before starting

**CLAUDE.md at the repo root describes a Django project and is stale.**
`package.json`'s own description says it plainly: *"Django legacy lives at
apps/, src/, services/ until cutover."* The actual live codebase — where
every M1–M4 PR landed, where #61/#73/#74 name their own file paths, and
where the last 5 commits on `staging` are — is the TypeScript monorepo:

- `apps/web` — Hono API on Cloudflare Workers, Drizzle/Postgres (Neon), the
  student app.
- `apps/admin` — the instructor console (React, no router, tagged-union
  view state in `App.tsx`).
- `packages/ui` — shared types/components between the two.

This plan targets that stack. Test/typecheck commands are `npm run
typecheck` and `npm test` from the repo root (turbo), or `npx vitest run`
from `apps/web/` — **not** `uv run python run_tests.py`, which only runs
the legacy Django suite.

## Context

Issue #61 is the epic. Near-term scope (this milestone, decided
2026-07-28 per `docs/notes/transcript-2026-07-28.md`): institutional
LTI/Canvas API access is blocked on UW-IT/Instructure until ~Sept–Oct, so
instructors self-generate a Canvas API token and paste it into the admin
console instead. LTI 1.3 (#58–#60) is explicitly deferred, out of scope.

**The schema was already scaffolded for this** (migration `0000`,
`apps/web/src/db/schema/identity.ts`) — `organizationCredentials`,
`lmsIntegrations`, `courses.canvasCourseId`,
`courseMemberships.canvasEnrollmentId/canvasRole`, and
`membershipDropReasonEnum.roster_removal` all already exist. This is much
less net-new schema than #73/#74's own "Code Framework" sections assume
(those were written before the schema landed). What's missing is real
gaps, not a guess:

- `organizationCredentials.secretRef` is `NOT NULL` and is used **only**
  as an allowlisted **env-binding name** (`apps/web/src/lib/llm-config.ts`,
  `ALLOWED_SECRET_REF_BINDINGS`) — a platform-deployed Wrangler secret like
  `OPENROUTER_API_KEY`. There is no write path to this table at all today.
  This mechanism is fundamentally unsuited to an instructor-pasted,
  per-org, runtime-supplied Canvas token: it can't be pre-declared as a
  Wrangler secret at deploy time. **Design decision #1 below.**
- `lmsIntegrations.ltiIss/ltiClientId/ltiDeploymentId` are `NOT NULL` —
  every column of the LTI-launch triple. A token-only integration has none
  of these. **Design decision #2.**
- No Canvas API client, no credentials repository/routes, no sync service,
  no admin UI, no runbook. All net-new.
- `roster.ts`'s `upsertCourseMember(s)` is **already the intended landing
  spot** — its own header comment names "a Canvas roster sync (#74/#11x)
  to come" as the third input to the one provisioning pipeline, alongside
  manual add and CSV import. Reuse it; do not fork a parallel write path.

## Explicit scope boundaries

- **No LTI 1.3, no NRPS.** #58–#60 stay untouched.
- **No grade passback.** Named as an explicit non-goal in #61.
- **No new course-creation UI.** Nothing in this codebase creates a
  `courses` row outside `scripts/seed.ts` today; building general course
  creation is a separate, larger feature. Course linking in this plan
  assumes the llteacher course already exists and links an *existing*
  course to a Canvas course id — matching #74's own wording ("map a Canvas
  course to an llteacher course"), not "create one from Canvas."
- **No WorkOS bulk-invite API integration.** See design decision #3 — the
  existing pending-user/first-login reconciliation path already satisfies
  #74's "WorkOS pre-population" requirement without new code.

## Design decisions

**1. Where an instructor-supplied Canvas token actually lives.**
Add a nullable `encryptedSecret` (`encryptedText`) column to
`organizationCredentials`, reusing the *same* AES-256-GCM
`IdentityCipher` primitive already used for PII (`identity-cipher.ts`) —
not a new crypto path, not a real call to a secrets-manager API. Make
`secretRef` nullable. A check constraint enforces exactly one of
`secretRef` / `encryptedSecret` is set per row. The existing
`resolveApiKey`/`ALLOWED_SECRET_REF_BINDINGS` LLM-credential path
(`llm-config.ts`) is untouched — it only ever reads `secretRef` rows, so
provider-credential resolution behavior for chat is unchanged.
`encryptedSecret` is read **only** by the new Canvas API client code.
Masking (first 2 + last 2 chars) is computed from the decrypted plaintext
at response time, never stored, never logged.

**2. `lmsIntegrations`'s LTI columns, for a row with no LTI launch.**
Make `ltiIss`, `ltiClientId`, `ltiDeploymentId` nullable. Replace the
existing `(ltiIss, ltiClientId, ltiDeploymentId)` unique index with a
partial one (`WHERE lti_iss IS NOT NULL`), since near-term rows carry all
three as null and an unqualified unique index would let only one such row
exist per organization. Add `canvasBaseUrl` (text — e.g.
`https://uw.instructure.com`, per-org so this isn't hardcoded to UW, per
#61's own acceptance criterion), `lastSyncStatus` (enum: `idle`,
`syncing`, `success`, `error`), `lastSyncCounts` (jsonb:
`{added,updated,removed}`), `lastSyncErrorMessage` (text). `courses.
lastSyncedAt` already exists and is reused as-is.

**3. WorkOS pre-population — decided by reuse, not new code.**
#74 asks the implementer to decide and record this. The existing
mechanism (`roster.ts`'s `upsertCourseMember(s)` creates a **pending**
`users` row; `UserIdentityService.createOrClaimUser` reconciles it by
`emailBlindIndex` on first WorkOS login) already *is* the
"allow-on-first-login" option, and it's already exercised in production
for manual add, CSV import, and NetID entry. Canvas sync reuses this same
pipeline rather than bulk-inviting synced students into the WorkOS
org. Recorded here as the decision; no WorkOS API code is added.

**4. Sync algorithm — idempotent, three passes, diffed on
`canvasEnrollmentId`.**
1. **Known rows**: enrollments whose id matches an existing
   `courseMemberships.canvasEnrollmentId` → direct `role`/`canvasRole`
   UPDATE (and restore if previously `roster_removal`-dropped). Canvas is
   authoritative for a row it already owns, so this bypasses
   `upsertCourseMembers`'s deliberate "don't auto-promote a role
   conflict" refusal — that refusal exists to protect a *manually*
   curated membership from being silently reassigned, which does not
   apply to a membership sync itself created.
2. **New-to-Canvas rows**: enrollments with no existing
   `canvasEnrollmentId` match → resolved by email through
   `upsertCourseMembers` (creates a pending user + membership, or
   reactivates/confirms a manually-added person now also seen in Canvas),
   then `canvasEnrollmentId`/`canvasRole` stamped onto the resulting
   membership in one batched UPDATE.
3. **Removed rows**: existing active memberships with a
   `canvasEnrollmentId` set that is **not** in this sync's enrollment-id
   set → soft-dropped, `droppedReason: "roster_removal"` (the exact enum
   value `roster.ts`'s manual removal already uses — no new enum member).

Fetch-then-write, not interleaved: every enrollment page is pulled and
held in memory before any write starts, so a mid-fetch failure (pagination
error, token revoked, rate limit) leaves the roster untouched rather than
half-synced. Writes reuse `upsertCourseMembers`'s existing per-row-result
batching, so one bad row is reported, not fatal to the batch.

**5. Canvas role → `course_role` mapping** (documented once, in the sync
service, not re-derived at each call site):

| Canvas `enrollment.type` | `course_role` |
|---|---|
| `TeacherEnrollment` | `instructor` |
| `TaEnrollment` | `ta` |
| `StudentEnrollment` | `student` |
| `ObserverEnrollment` | `observer` |
| `DesignerEnrollment` | `instructor` (closest available — content-authoring access, no direct equivalent role) |
| anything else | skipped, reported as a per-enrollment sync error, not fatal to the run |

**6. Pagination & rate limits.** Canvas paginates via the `Link` response
header (`rel="next"`), not a page-number param — the client follows it
until absent. Canvas signals rate-limiting via `X-Rate-Limit-Remaining`
approaching `0` (not classic HTTP 429); the client checks that header,
and on a `403` whose body says `Rate Limit Exceeded` backs off once with a
short delay and retries a bounded number of times before failing the
whole fetch phase with a stated, stored error.

## Migration

Edit `apps/web/src/db/schema/identity.ts` per decisions #1/#2, then
`cd apps/web && npm run db:generate` to produce the next-numbered
migration (`0046_...sql`) the normal way — not hand-written SQL — so it
matches every other migration's drizzle-kit provenance.

## Files to create/touch

**Schema/migration**
- `apps/web/src/db/schema/identity.ts` — decisions #1/#2.
- `apps/web/src/db/migrations/0046_*.sql` (generated).

**Canvas API client**
- `apps/web/src/lib/canvas-api.ts` (new) — thin client: `validateToken`
  (`GET /api/v1/users/self`), `listCourses` (`GET /api/v1/courses`),
  `listEnrollments` (`GET /api/v1/courses/:id/enrollments`, paginated).
  Takes `baseUrl` + `token` as plain args — never touches the DB or the
  cipher itself, so it's unit-testable with mocked `fetch` alone.
- `apps/web/src/lib/canvas-api.test.ts` (new) — pagination (Link-header
  following, termination on last page), rate-limit backoff/retry, and
  error-shape tests against mocked `fetch`.

**Credential management (#73)**
- `apps/web/src/server/repositories/organizationCredentials.ts` (new) —
  create/replace/delete/get-masked, all org-scoped, all going through
  `encryptedSecret` for provider `canvas`.
- `apps/web/src/server/repositories/organizationCredentials.test.ts` (new).
- `apps/web/src/server/routes/canvasCredentials.ts` (new) — CRUD +
  `/validate`, `requireInstructorOf`-gated like `llmConfigs.ts`, following
  its exact validation/error-shape/audit conventions.
- `apps/web/src/server/routes/canvasCredentials.test.ts` (new).

**Roster sync (#74)**
- `apps/web/src/server/repositories/lmsIntegrations.ts` (new) — link a
  course to a Canvas course id + credential; read sync status.
- `apps/web/src/lib/services/CanvasRosterSyncService.ts` (new) — the
  3-pass algorithm above; calls `roster.ts`'s `upsertCourseMembers`, never
  duplicates its logic.
- `apps/web/src/lib/services/CanvasRosterSyncService.test.ts` (new, mocked
  Canvas API + mocked db) — pagination correctness, idempotent re-sync,
  pending-user reconciliation, dropped-enrollment handling, role-change
  tracking, per-row error isolation.
- `apps/web/src/lib/services/CanvasRosterSyncService.db.test.ts` (new,
  real local Postgres, same convention as `sectionConversations.db.test.ts`
  etc.) — the same scenarios against a real DB, since the batched
  `roster.ts` writes this depends on have DB-level race/constraint
  behavior a mocked test can't exercise.
- `apps/web/src/server/routes/canvasSync.ts` (new) — `POST .../canvas/sync`,
  `GET .../canvas/status`, `GET .../canvas/courses` (course picker),
  `PUT .../canvas/link`. `requireInstructorOf`-gated.
- `apps/web/src/server/routes/canvasSync.test.ts` (new).

**Wiring**
- `apps/web/src/server/index.ts` — register the new routes, same style as
  every existing block (comment naming the issue + guard rationale).
- `apps/web/src/server/utils/audit.ts` — new `AUDIT_ACTIONS` entries
  (`CANVAS_TOKEN_SET`, `CANVAS_TOKEN_REPLACED`, `CANVAS_TOKEN_DELETED`,
  `CANVAS_TOKEN_VALIDATED`, `CANVAS_COURSE_LINKED`, `CANVAS_SYNC_STARTED`,
  `CANVAS_SYNC_COMPLETED`, `CANVAS_SYNC_FAILED`) and a
  `CREDENTIAL`/`LMS_INTEGRATION` `AUDIT_TARGET_TYPES` entry.
- `apps/web/src/shared/types.ts` (or wherever the LLM-config wire types
  live) — request/response types for the new routes, imported by both
  apps/web and apps/admin per existing convention.

**Admin UI**
- `apps/admin/src/client/views/CanvasIntegrationView.tsx` (new) — two
  sections: token management (masked display, Validate, Replace, Delete)
  and course link + sync (course picker from the token's visible courses,
  Link, Sync from Canvas button, last-sync status/counts/errors).
  Patterned directly on `TaCapabilitiesView.tsx`'s conventions: one
  `aria-live` announcer region, abortable fetches with `abortAfter`,
  server-message-first error copy, focus management on row loss.
- `apps/admin/src/client/App.tsx` — new `View` case, wired like
  `llm-configs`.
- `apps/admin/src/client/components/AdminSidebar.tsx` — new `authorOnly`
  nav entry.

**Docs**
- `docs/operations/canvas-token-setup.md` (new) — instructor-facing
  runbook: generating a token in Canvas (Account → Settings → New Access
  Token), the scopes the sync needs (`url:GET|/api/v1/courses`,
  `url:GET|/api/v1/courses/:id/enrollments`, `url:GET|/api/v1/users/self`),
  quarterly rotation, what "Validate" checks, support contact. Matches the
  path #61's own acceptance checklist names.

## Testing strategy

Covers every "Must-cover risk" both issues' bodies name:

- Token plaintext never returned to any client (assert on response JSON,
  not just on what a handler *intends* to send).
- Cross-org credential/course access refused (403), mirroring
  `llmConfigs.test.ts`'s org-scoping tests.
- Validate flow against mocked Canvas (`/users/self` 200 and 401/403).
- Pagination correctness (multi-page mocked `Link` headers, loop
  terminates on the last page).
- Idempotent re-sync (sync twice, second run reports 0 added).
- Pending-user reconciliation reuses `roster.ts` — covered by its own
  existing test suite; the sync test asserts it calls that path rather
  than re-testing user creation from scratch.
- Dropped-enrollment handling (`droppedReason: "roster_removal"`, row not
  deleted).
- Role-change tracking on an already-synced `canvasEnrollmentId`.
- Rate-limit backoff and pagination termination (`canvas-api.test.ts`,
  no network).

Run: `npm run typecheck` (root), `npm test` (root, turbo), plus
`npx vitest run --testTimeout=30000` from `apps/web/` for the
`.db.test.ts` suite against the local Docker Postgres (`DATABASE_URL`
from `.dev.vars`), matching the command the 08-12 M4 sync entry
documents.

## Manual verification

Before opening the PR: run the admin app (`npm run dev` from `apps/admin`,
`apps/web`), walk the full flow in a real browser — paste a token (a
fixture/test token is fine, validation will legitimately fail without a
live Canvas account; assert the error path renders correctly), confirm
masking, link a seeded course, trigger a sync against a mocked/stubbed
Canvas response if no live token is available, and confirm the sync
status/counts render. Screenshot the token settings and sync status
states for the PR description.

## Epic (#61) acceptance pass

Once #73/#74 are implemented and tested, re-read #61's own "End-to-end
acceptance checklist" line by line against the real code (not from
memory) before closing it, the way the M4 plan's epic-closure entries did
— check off what's genuinely satisfied, note explicitly what's deferred
(LTI, grade passback) rather than silently dropped.
