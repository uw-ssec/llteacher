# Super-admin course provisioning and instructor-owned Canvas credentials

**Date:** 2026-10-08  
**Status:** Approved design

## Purpose

An LLTeacher deployment needs a complete first-run path that does not require
an engineer to seed tenant or course rows. For the UW deployment, a super admin
must be able to establish UW as the deployment's institution, grant a professor
instructor-console access, and create a course shell assigned to that professor.
The professor then runs the course: they may connect Canvas, sync its roster,
manage TAs, upload knowledge, and author course content.

The same code must remain deployable by another institution without embedding
UW-specific records or changing anything in WorkOS.

## Product boundaries

- One local institution belongs to one LLTeacher deployment.
- WorkOS remains the authentication provider. LLTeacher does not create,
  update, or delete WorkOS organizations.
- Institution setup creates only LLTeacher database records.
- A super admin provisions the institution, instructors, and course shells.
- An assigned instructor operates the course after signing in.
- Canvas linking is optional. Creating a course never depends on Canvas.
- Canvas roster sync imports enrollments, not assignments, modules, files, or
  gradebook data.
- Course materials continue through the existing Knowledge upload flow.
- Supporting several institutions within one deployment is out of scope.

## Roles and authority

### Super admin

A configured super admin may:

- complete first-run institution setup;
- grant instructor-console access by UW/institutional email;
- create a course shell and assign its primary instructor; and
- view the success or failure of those provisioning operations.

The super admin is not added as a course member. Existing server-side
super-admin bypasses remain available for operational recovery, but the normal
product workflow does not make the super admin a participant in every course.

### Platform instructor

A platform-instructor grant admits a person to the instructor portal before
they have a course. It does not grant authority over any course.

### Course instructor

The course membership is the authority to operate a specific course. An
assigned instructor may manage homeworks, students, TAs, knowledge, Canvas,
exports, grading, and the other instructor-only course surfaces already in the
console.

## User experience

### First-run institution setup

When an authenticated super admin opens the instructor console and the database
contains no organization, the portal shows **Set Up Institution** instead of
course-scoped screens. The form collects:

- institution name, for example `University of Washington`;
- stable slug, for example `uw`; and
- one or more allowed login domains, for example `uw.edu`.

Submission creates exactly one local organization. It does not call a WorkOS
write API. If the authenticated session contains an existing WorkOS
organization identifier, LLTeacher records it as the authentication-tenant
association. The local organization remains usable when AuthKit provides no
organization identifier.

Once an organization exists, first-run setup is no longer offered. The server
also enforces the single-institution invariant so a forged or repeated request
cannot create a second organization.

### Super-admin navigation

The super-admin sidebar includes two course-independent entries even when the
super admin has no course memberships:

- **Add Instructor** grants instructor-console access without creating a
  course.
- **Course Setup** creates a course shell and assigns its primary instructor.

The Course Setup form collects:

- primary instructor email;
- course title;
- course code; and
- term.

On success, it shows the course identity and assigned instructor and explains
that the instructor can now sign in and operate the course. A course with the
same normalized code and term in the deployment is rejected as a duplicate.

### Instructor navigation

An instructor with one course enters it directly. An instructor with several
courses uses a course switcher in the shared top navigation. The selection is
used by every course-scoped instructor view and persists for that user. A stale
saved selection falls back to the first active instructor course.

The current hard-coded admin course and term labels are replaced with values
from the selected course.

### Canvas experience

The Canvas screen has two distinct sections:

1. **My Canvas account** manages the signed-in instructor's encrypted Canvas
   token and Canvas base URL. It is independent of the selected course.
2. **This course's Canvas connection** optionally links the selected LLTeacher
   course to a Canvas course visible through that credential, then runs the
   existing roster synchronization.

An instructor enters their token once and may reuse it for several courses.
Canvas is never required to create or operate an LLTeacher course.

## Server interfaces

### Institution setup

`GET /api/platform/institution`

- Super-admin only.
- Returns the single local institution or `null` before setup.
- Never returns authentication secrets.

`POST /api/platform/institution`

- Super-admin only.
- Accepts `name`, `slug`, and `allowedDomains`.
- Creates the one local institution and records the session's existing WorkOS
  organization identifier when present.
- Returns `409` when an institution already exists or the slug/domain policy
  conflicts with stored data.

### Course provisioning

`POST /api/platform/courses`

- Super-admin only.
- Accepts `title`, `code`, `term`, and `instructorEmail`.
- Normalizes and validates the email against the institution allowlist.
- In one database transaction:
  1. creates or reuses the pending user;
  2. grants platform-instructor access;
  3. creates the course under the deployment institution;
  4. creates or restores the instructor course membership.
- After commit, writes best-effort audit events for the instructor grant,
  course creation, and membership grant, following the repository's existing
  rule that an audit-sink failure does not report an already-committed product
  mutation as failed. The platform-instructor row retains its existing
  granted-at and granted-by provenance independently of the audit sink.
- Returns the created course and an instructor summary with no encrypted fields
  or blind indexes.
- Rejects duplicate normalized `(code, term)` values within the institution.

### Course listing

The profile/course-list contract must provide every active instructor course,
including code and term. The admin client chooses an active course explicitly
instead of assuming `courses[0]` is the permanent context.

## Data model

### Organization

`organizations.workos_organization_id` becomes nullable because an institution
record is local product tenancy, while AuthKit may authenticate an allowed
institutional user without returning an organization context. A non-null value
retains its existing uniqueness constraint. The deployment still permits only
one organization row through the platform setup repository and route.

### Course identity

Add a database uniqueness constraint over the normalized institution, course
code, and term. Normalization trims surrounding whitespace and compares code
and term case-insensitively. Course title remains editable display text and is
not part of identity.

### Instructor-owned Canvas credential

Canvas tokens move from organization ownership to user ownership:

- an encrypted token belongs to one instructor user;
- the base URL, masked token, expiry metadata, and rotation timestamps remain;
- there is at most one active Canvas credential per instructor;
- the credential is never returned in plaintext;
- only its owner may set, replace, validate, or remove it; and
- a super admin may read masked ownership/status metadata for recovery but not
  use or reveal the secret.

Each course's `lms_integrations` row already identifies the credential used for
the link. Linking verifies that the selected Canvas course is visible through
the signed-in instructor's credential. A later sync uses the credential bound
to that integration rather than whichever token happened to be written most
recently at organization level.

Existing organization-scoped Canvas credentials are migrated without exposing
plaintext. Where a linked course has an unambiguous instructor owner, the
encrypted credential is copied to that instructor and the integration is
rebound. Ambiguous legacy links remain readable but surface an actionable
"Reconnect Canvas" state; migration must never guess which instructor owns a
secret.

## Transactions and failure handling

Institution setup is idempotent at the repository boundary and fails closed if
another organization already exists.

Course provisioning's product writes are atomic. A failure in user
provisioning, instructor granting, course creation, or membership creation
rolls back the operation. Audit writes run best-effort after commit, matching
the existing application-wide audit policy. Retrying the exact request must
not create a second user, course, or membership.

Canvas connection remains a later, separate workflow. Canvas outages,
revocations, and rate limits therefore cannot block course creation. Roster
sync preserves its current fetch-before-write behavior and per-row error
reporting.

All errors shown in the portal state what was preserved and what action the
user can take next. Secrets, encrypted values, blind indexes, and raw provider
responses never appear in errors or logs.

## Security and audit requirements

- Institution and course provisioning routes require `isSuperAdmin` both in
  middleware and in defensive handler checks.
- Instructor Canvas routes require an authenticated active user with a
  platform-instructor grant or instructor/admin course membership.
- Course link and sync routes additionally require instructor authority over
  the selected LLTeacher course.
- Canvas tokens are encrypted with the existing AES-256-GCM secret boundary.
- Token-bearing request bodies are never logged or included in audit metadata.
- Institution setup, platform-instructor grant, course creation, course
  membership grant, credential rotation, Canvas linking, and roster sync are
  audited at their appropriate local institution/course scopes.
- Allowed-domain validation occurs server-side even when the client already
  validates the email.

## Verification

Automated coverage must include:

- first-run setup succeeds for a super admin and refuses non-super-admins;
- a second institution cannot be created;
- malformed slugs and domains are rejected;
- course provisioning creates the pending user, grant, course, and instructor
  membership together;
- a failure in any provisioning write leaves none of those records committed;
- duplicate code and term are rejected case-insensitively;
- an instructor with zero courses can enter the console but cannot reach
  course-scoped actions;
- the assigned instructor sees the new course after sign-in;
- the admin course switcher scopes every view to the selected course and
  recovers from a stale saved selection;
- one instructor credential can link several courses;
- two instructors' credentials cannot overwrite or read each other;
- Canvas link and sync use the credential bound to that integration;
- legacy credential migration never exposes plaintext or guesses ownership;
- Canvas linking remains optional; and
- existing TA, roster, knowledge, homework, and grading behavior remains
  unchanged for a single-course instructor.

Run focused route, repository, migration, and React component suites during
development, then the complete repository test suite before completion.

## Out of scope

- Creating or modifying organizations in WorkOS.
- Multiple local institutions in one LLTeacher deployment.
- Importing Canvas assignments, modules, files, knowledge materials, or grades.
- Automatic or scheduled Canvas roster synchronization.
- Canvas grade passback.
- A general organization-administration console beyond first-run setup.

## Implementation decisions — 2026-10-08

- The deployment institution is identified by `organizations.deployment_singleton = true`. A partial unique index permits at most one such row while leaving ordinary non-deployment organization fixtures possible. The migration marks the oldest existing organization as the deployment institution; a clean database marks none until first-run setup.
- `workos_organization_id` is nullable. When AuthKit supplies one during first-run setup it is stored as provenance, but LLTeacher never creates or updates a WorkOS organization.
- Course code and term are unique case-insensitively within the institution. A duplicate provisioning request returns `409` rather than silently reassigning the existing course.
- Course provisioning uses the Node PostgreSQL driver's interactive transaction and a transaction-scoped advisory lock on normalized instructor email. This makes pending-user creation, instructor grant, course creation, and membership creation all-or-nothing under concurrent requests.
- The admin console stores its selected course in `llteacher:admin-selected-course`. A missing or stale value falls back to the first authorized profile course; changing it resets nested view state to Homeworks before new course-scoped requests run.
- Canvas credentials carry nullable `owner_user_id`. New writes always set the authenticated instructor. Existing null-owner Canvas rows remain legacy records and produce reconnect-required UI; ownership is never inferred from memberships or an existing course link.
- Course roster sync loads the exact `lms_integrations.api_credential_id` and requires its owner to match the caller. A co-instructor must explicitly reconnect/relink with their own credential before they can sync.
