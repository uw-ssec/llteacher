# Multi-Tenant Data Model — Evaluation and Scope

Status: research draft (branch `cdcore/chore/research`)
Author: Cordero Core, SSE Center
Context: evaluating LLteacher as the shared base for the four UW CDI AI tutoring projects (LLteacher / Stats, Polya / Civil-Mech Eng, AI-PFTS / Econ, Clinical Informatics).

## Implementation status

§6.1 (Identity & Tenancy) and §6.2 (Content & Configuration) landed with the M1 auth milestone. **§6.3 (Runtime — Conversation, Grading, Audit) landed with the M2 epic** ([#18](https://github.com/uw-ssec/llteacher/issues/18)): `conversations`, `messages`, `submissions`, `grades`, `citations`, `llm_call_logs`, `student_profiles`, `audit_events` all exist as Drizzle schema in `apps/web/src/db/schema/runtime.ts`, plus an org/course-scoped repository layer and a TypeScript seed script. Full implementation plan, including every deviation from this doc's design and the reasoning behind each: [docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md](../superpowers/plans/2026-08-03-m2-runtime-persistence.md).

§3.5 open design questions, status after M2:
1. **Conversation uniqueness** — resolved for the active case. A partial unique index enforces at most one active section-conversation per (user, section); see the plan doc's decision #1. **Deferred to M3**: this does not fully replicate `Submission.clean()`'s guarantee across a soft-delete-and-recreate cycle — a student can currently accumulate more than one `submissions` row for the same section if their conversation is soft-deleted and a new one created for the same section. Deliberately not fixed in M2, since "can a student resubmit, and what happens to the old conversation" is a product decision neither Django nor this doc ever made — see [#128](https://github.com/uw-ssec/llteacher/issues/128).
2. **Prompt template inheritance** — unchanged from this doc; not touched by M2.
3. **Material chunk storage** — unchanged; pgvector as designed.
4. **Migration of Sara's live data** — not started.
5. **Hard-delete path** — not started; M2's `conversations`/`messages`/`submissions` still cascade-delete on their parent. **Post-epic addendum (issue #133):** the one exception is `grades` and `llm_call_logs`, which are `ON DELETE RESTRICT` from their immediate parent (`grades.submission_id`; `llm_call_logs.message_id` and `.conversation_id`) — until a real FERPA hard-delete flow exists, deleting a user (or anything upstream of it) is blocked outright if it would silently destroy a grade record or LLM cost/telemetry log, rather than letting the cascade erase them as a side effect. A user with no graded submissions and no logged LLM calls can still be deleted normally. **Org deletion is unchanged and still cascades everything, including `audit_events`** — there is no restrict on `audit_events.organization_id`, so deleting an organization row destroys its own compliance log along with it. That's acceptable only because org deletion has no code path today (the only caller is the seed script's `--reset`, scoped to the disposable `seed-org`); before any real "delete an organization" feature ships, this needs either an explicit export-before-delete procedural step or a restrict/soft-delete redesign of `audit_events` — tracked as a prerequisite for that future feature, not a gap this issue closes.
6. **Canvas role mapping precedence** — unchanged from M1.

M2 also intentionally diverges from this doc in two places: `conversations`/`messages` do **not** carry a denormalized `organization_id` (they scope via `course_id` instead — see the plan doc's decision 4/5), and `Message.content_type` was dropped in favor of an AI-SDK-shaped `parts` jsonb column rather than the `role`/`content_type` split described in §3.2 (plan doc decision 2).

---

## 0. Decisions Locked In (rev 3)

1. **Identity** — UW NetID is the local part of the UW email (`cdcore@uw.edu` → `cdcore`). `User` stores `email`, `netid`, and `display_name`, all **AES-256-GCM encrypted at rest** with sibling HMAC-SHA256 blind-index columns for equality lookup (see #4). `workos_user_id` remains plaintext as a pseudonymous join key.
2. **Profiles** — drop `Teacher` / `Student`. Role lives on `CourseMembership` with an enum.
3. **External systems** — WorkOS is the identity/auth plane (SSO, AuthKit, JWT-backed sessions). Canvas API is the course/roster data plane: `Course` and `CourseMembership` are projections of Canvas state, pulled via the [Canvas API](https://developerdocs.instructure.com/services/catalog/openapi) on a schedule (and, later, Canvas Live Events webhooks for real-time).
4. **At-rest encryption for PII** — all directly identifying PII columns are encrypted with AES-256-GCM via a `customType<Ciphertext>` in `apps/web/src/db/types/encrypted.ts`. Equality lookup uses sibling HMAC-SHA256 blind-index columns (`*_blind_index`, `bytea`, unique where required). The cipher class is `apps/web/src/lib/crypto/identity-cipher.ts`. The encryption key and the blind-index key are *separate* keys, rotated independently. v0 ships with WebCrypto + keys loaded from Cloudflare Secrets Store; HIPAA path (Clinical Informatics) can swap in AWS KMS later without schema change.
4a. **Content encryption boundary** (added post-M2 review, [#134](https://github.com/uw-ssec/llteacher/issues/134)) — decision #4 above covers *identity* PII (email, netid, display name). M2 added three more content-bearing tables and none of them got the same treatment; that gap was never a decision, just an omission, until now:
    - `messages.parts` (verbatim student/AI chat, the richest FERPA-protected content in the system) — **stays plaintext.** Reasoning: extreme write/read volume (every chat turn), needs to stay queryable for moderation and prompt-debugging without a decrypt-every-row pass, and Neon's at-rest disk encryption already covers the "raw DB exfiltration" threat `IdentityCipher`'s header documents as its actual threat model. Revisit if chat content starts routinely including the same directly-identifying strings decision #4 already protects (a student pasting their own SSN, say) — see the PII-minimization guard tracked in [#52](https://github.com/uw-ssec/llteacher/issues/52), which is the intended mitigation for that case, not column encryption.
    - `grades.feedback`/`grades.rubric` — **stays plaintext**, same reasoning: lower re-identification risk than a name/email/netid, and instructors need to read/search feedback without a decrypt round-trip.
    - `student_profiles.summary`/`student_profiles.mastery_signals` — **should be encrypted, unlike the other two**, because §3.2's own description of `StudentProfile` explicitly includes accommodations (disability status, extended-time flags, etc.) in this table's long-lived learning state. Accommodations data is a categorically more sensitive class of FERPA/ADA-protected data than ordinary chat or grade-feedback content — closer to decision #4's "directly identifying" bar than to `messages`/`grades`. M2 shipped both columns plaintext; that's a real gap, not a considered decision, and is tracked as a follow-up: [#137](https://github.com/uw-ssec/llteacher/issues/137) (M9).

These shape §3 and §6 below.

---

## 1. Current Data Model

### Entities (as of `cdcore/chore/research`)

| App | Model | Key fields | Relationships |
|---|---|---|---|
| accounts | `User` | UUID pk, AbstractUser | — |
| accounts | `Teacher` | 1:1 → User | created/updated timestamps only |
| accounts | `Student` | 1:1 → User | created/updated timestamps only |
| homeworks | `Homework` | title, description, due_date | FK → Teacher, FK → LLMConfig (nullable) |
| homeworks | `Section` | order (1–20), content | FK → Homework, 1:1 → SectionSolution |
| homeworks | `SectionSolution` | content | reverse 1:1 from Section |
| conversations | `Conversation` | is_deleted, deleted_at | FK → User, FK → Section |
| conversations | `Message` | content, `message_type` (free-form string) | FK → Conversation |
| conversations | `Submission` | submitted_at only | 1:1 → Conversation |
| llm | `LLMConfig` | name, model_name, api_key, base_prompt, temperature, max_completion_tokens, is_default, is_active | global pool |

### Implicit assumptions baked into the schema

1. **One institution, one course.** No `Organization`, `Course`, or `Term` entity. The word "Section" is overloaded (it means a homework sub-part, not a course section).
2. **Teacher owns Homework directly** via a FK. No co-instructors, TAs, or course staff.
3. **`LLMConfig` is global.** Any teacher sees every config; `is_default` is a single global flag.
4. **No grading model.** `Submission` carries only `submitted_at` — no grade, feedback, rubric, or grader. Sara's "conversation-quality grading" is not represented.
5. **No prompt layering.** Only `LLMConfig.base_prompt` exists. The level-1 (behavior) / level-2 (problem-specific) prompt pattern Sara described has no home.
6. **No course materials.** No documents, chunks, embeddings, or citations — required by AI-PFTS and Clinical Informatics for course-content grounding.
7. **No tenant boundary.** `User.username` is globally unique. Teachers and students from different orgs would collide.
8. **`LLMConfig.api_key` is a plaintext `CharField`.** Already a smell in single-tenant; a non-starter in multi-tenant where each org will likely supply its own enterprise key.
9. **`Message.message_type` is an unenforced string.** Mixes role (`student`, `ai`, `system`) with payload type (`r_code`, `file_upload`, `code_execution`). Hard to reason about for analytics or multi-agent flows.
10. **No audit log.** FERPA and HIPAA both require access auditing on student records; the schema has none.
11. **No LMS context.** Nothing models a Canvas course id, LTI deployment, or external identifier — every PI hit this wall.
12. **Conversation uniqueness is implicit.** No `unique_together` on (user, section); soft-delete suggests multiple attempts, but the rules aren't expressed.

### What the current model does well

- UUID pks everywhere — safe for cross-tenant merging and exposure in URLs.
- Clear app boundaries with FK names that read naturally.
- Soft-delete on `Conversation` (worth extending, not retracting).
- `Section.order` is constrained with validators.

These are worth preserving in the rewrite.

---

## 2. Cross-Project Requirements (from SEED-AI exchange, 2026-05-27)

Distilled from `.agents/meeting_ai_at_uw_seed_ai_project_exchange.md` and the project-context memory:

| Requirement | LLteacher (Stats) | Polya (Eng) | AI-PFTS (Econ) | Clinical Informatics |
|---|---|---|---|---|
| Multi-section homeworks | ✅ exists | needed | needed | needed |
| Per-homework / per-section system prompts | needed (level-1/2) | needed (phase prompts) | needed | needed |
| Course-material upload + RAG | floated | useful | **required** | **required** |
| Canvas / LTI integration | needed | needed | needed | **required** |
| AI grading / feedback on submissions | conversation-quality | reasoning quality | short-essay grading | rubric-based |
| Per-student profile across sessions | useful | **required** | useful | useful |
| Multi-agent (tutor + evaluator + profile-builder) | floated | floated | floated | floated |
| FERPA | ✅ | ✅ | ✅ | ✅ |
| HIPAA | — | — | — | **required** |
| Per-org enterprise LLM credentials | needed | needed | needed | **required** |
| Phase state in a conversation | — | **required** (4 Polya phases) | — | — |

Polya is the most structurally divergent. If the proposed model survives Polya's needs, the other three fit comfortably.

---

## 3. Proposed Multi-Tenant Data Model

### 3.1 New tenancy layer

```
Organization
  ├─ OrganizationCredential   (encrypted API keys, secret refs)
  ├─ LLMConfig                (org-scoped pool of model configs)
  ├─ PromptTemplate (org-level defaults)
  └─ Course
       ├─ CourseMembership    (User ↔ Course, role enum)
       ├─ LMSIntegration      (Canvas course id, LTI deployment)
       ├─ CourseMaterial      (uploaded docs)
       │    └─ MaterialChunk  (RAG chunks + embeddings)
       ├─ PromptTemplate      (course-level overrides)
       └─ Homework
            ├─ PromptTemplate (homework-level overrides)
            └─ Section
                 ├─ SectionSolution
                 ├─ PromptTemplate (section-level overrides, e.g. Sara's level-2)
                 └─ Conversation
                      ├─ ConversationPhase  (Polya state, nullable)
                      ├─ Message            (role enum: user|assistant|system|tool; agent FK)
                      │    └─ Citation     (→ MaterialChunk)
                      ├─ LLMCallLog        (per-call telemetry)
                      └─ Submission
                           └─ Grade        (rubric, score, feedback, grader)
StudentProfile (per User × Course, long-lived learning state)
AuditEvent     (append-only, FERPA/HIPAA)
```

### 3.2 Entity-by-entity changes

**`Organization` (new)**
- Top-level tenant. Examples: "UW Department of Statistics", "UW Civil & Mech Eng", "UW Medicine".
- Holds policy flags: `requires_hipaa: bool`, `data_residency: str`, `default_llm_config_id`.
- Owns credentials, prompt defaults, LLM config pool.

**`Course` (new)**
- Belongs to Organization. Fields: `code` (STAT 311), `term` (Fall 2026), `title`, `external_id` (Canvas course id, nullable), `is_active`.
- Replaces the implicit "the database is one course" assumption.

**`CourseMembership` (new)**
- `(user, course, role)` where role ∈ {instructor, ta, student, observer, admin}.
- Replaces the global `Teacher` / `Student` profiles, or supplements them — see §3.4.
- Carries enrollment dates and drop status for students.

**`User` (modified)**
- Stays global (one identity across courses).
- Authoritative identity ref: `workos_user_id` (plaintext, partial-unique where non-null). Login + profile claims flow from WorkOS AuthKit; LLteacher's session is derived from a WorkOS-issued JWT.
- `email`, `netid`, `display_name` — all **encrypted at rest** (`bytea`, AES-256-GCM via the `encryptedText` column type). Normalization (`trim().toLowerCase()` for email and netid) happens *before* both encryption and blind-index computation, on the application side.
- `email_blind_index` (`bytea`, unique) and `netid_blind_index` (`bytea`, partial-unique where non-null) — HMAC-SHA256 over the normalized plaintext, the only equality-lookup path for those fields. No blind index on `display_name` (we never look users up by display name).
- Reconciliation of pending users: Canvas roster sync writes the encrypted email + blind index immediately. First WorkOS login computes the blind index of the WorkOS-claim email, finds the pending row, populates `workos_user_id`, sets `is_pending = false`.

**`Teacher` / `Student` (removed)**
- Both models drop. Role lives on `CourseMembership.role` (enum: `instructor | ta | student | observer | admin`).
- The `Conversation.is_teacher_test` property collapses into a `CourseMembership.role` check, which is more honest about what it's actually asking.
- Migration: existing `Teacher` and `Student` rows become `CourseMembership` rows on the seed Course (see §4).

**`Homework` (modified)**
- `created_by` → FK to `CourseMembership` (not `Teacher`), so co-instructors and TAs can own assignments.
- Add `course` FK (denormalized but worth it; Section → Homework → Course is already implicit).
- Add `prompt_template` FK (nullable; inherits from Course if absent).

**`Section` (mostly unchanged)**
- Add optional `prompt_template` FK for Sara's level-2 problem-specific prompts.
- Consider renaming to `HomeworkPart` or `HomeworkStep` to free the word "Section" for academic course sections. Tradeoff: lots of churn, breaks all templates and URLs. Probably not worth it; document the naming collision instead.

**`Conversation` (modified)**
- Course context is implicit through Section → Homework → Course. Add `course_id` denormalized for query performance and as a tenancy guard.
- Add `conversation_type` enum: `recall | discovery | critical_thinking | tutor | evaluator` — captures Sara's three modes and prepares for multi-agent.
- Add nullable `phase` FK or string for Polya: `understand | plan | execute | reflect`.
- Keep soft-delete; add hard-delete path for FERPA "right to be forgotten" requests (rare but required).

**`Message` (modified — breaking change)**
- Replace `message_type` with two fields:
  - `role`: enum `user | assistant | system | tool` (matches OpenAI/Anthropic conventions).
  - `content_type`: enum `text | code | file_upload | code_execution_result | tool_call | tool_result`.
- Add `agent_id` (nullable FK to `AgentDefinition` or just a string) for multi-agent: distinguishes "tutor said" from "evaluator flagged" without abusing role.
- Add `prompt_template_version` FK so a conversation pins to the template version it was started with — protects against mid-course prompt edits silently changing past behavior.

**`Submission` (modified)**
- Add `Grade` as a separate child entity: `(submission, rubric, score, feedback, graded_by, graded_at, graded_by_ai: bool)`. Multiple grades possible (AI first, instructor override).

**`LLMConfig` (modified)**
- Moves under `Organization`. `is_default` becomes per-org.
- `api_key` removed; replaced by FK to `OrganizationCredential`, which holds an external secrets-manager reference (not the secret itself).
- Adds `provider` enum: `openai | anthropic | claude_for_education | openrouter | local`. Currently inferred from `model_name`, which is fragile.

**`PromptTemplate` (new)**
- Separates prompts from LLM configs (today they're glued together on `LLMConfig.base_prompt`).
- Scoped at four levels: org, course, homework, section.
- Resolved at runtime via inheritance chain. Versioned — every edit creates a new version.
- This is the direct model of Sara's level-1 (behavior, course-wide) / level-2 (problem-specific, per-section) prompt pattern.

**`CourseMaterial` + `MaterialChunk` (new)**
- `CourseMaterial`: uploaded artifact (PDF, slide deck, lecture transcript, syllabus). Fields: title, source_type, original_filename, upload metadata.
- `MaterialChunk`: chunked text + embedding. Fields: `material`, `ordinal`, `text`, `embedding` (pgvector or external store ref), `token_count`.
- `Citation` (new): links a `Message` or `Grade.feedback` to one or more `MaterialChunk`s. Required by AI-PFTS' "grounded in my course materials" need.

**`LMSIntegration` + `LTILaunch` (new)**
- Per-course LMS connection. Holds Canvas deployment_id, target_link_uri, public key, etc.
- `LTILaunch` records each launch (nonce, deployment_id, resource_link_id, role claim) for replay protection and debugging.

**`StudentProfile` (new)**
- Per `(User, Course)`. Long-lived learning state: mastery signals, prior-conversation summary, accommodations.
- Polya needs this explicitly. Sara's grading analytics benefit from it. Bias-mitigation concerns noted in the meeting — design as **derived** state, regenerable from raw conversations, not authoritative.

**`AuditEvent` (new)**
- Append-only. Records `(actor, action, target, target_type, timestamp, ip, course)`.
- FERPA: instructor access to student records. HIPAA: same plus stricter retention.
- Write path through a middleware/decorator, not ad-hoc.

**`LLMCallLog` (new)**
- Per-message LLM call: model, prompt_template_version, input_tokens, output_tokens, latency_ms, cost_cents, provider_request_id.
- Grants fund the tokens, but PIs and SSE both want the visibility.

**`AgentDefinition` (new, optional)**
- For multi-agent. Fields: `name` (`tutor`, `transcript_evaluator`, `profile_builder`), `role_description`, `default_prompt_template`, `default_llm_config`.
- Lets each conversation have multiple agent identities writing messages without overloading `role`.

### 3.3 Tenancy enforcement options

| Approach | Pros | Cons | Fit |
|---|---|---|---|
| **Shared schema with `org_id` column** | Cheap; one migration story; easy cross-org analytics; small ops surface | Every query must filter org_id; a single missing filter leaks data; weaker defense for HIPAA | Default for the three FERPA-only projects |
| **Schema-per-tenant** (`django-tenants`) | Stronger isolation; per-tenant backups; clearer compliance story | Operational complexity; every migration runs N times; cross-org reporting harder | Worth it if Clinical Informatics requires HIPAA-grade isolation |
| **Database-per-tenant** | Strongest isolation; regional residency possible | Heavy ops; hard to share infra cleanly | Likely overkill |

**Recommendation:** start shared-schema with an `OrgScopedQuerySet`/`OrgScopedManager` mixin that requires every query to pass an `organization` (or be explicitly marked cross-org). Add a model-level `org_id` denormalized on every "leaf" entity (Conversation, Message, Submission) — slight redundancy in exchange for guard-railing query authoring. Reserve schema-per-tenant for Clinical Informatics if UW-IT requires it; the entity model is the same either way.

### 3.4 External system integration: WorkOS + Canvas

Two systems sit upstream of the LLteacher database. Keeping their roles distinct prevents the data model from leaking either vendor's assumptions.

**WorkOS — identity & auth plane**
- WorkOS Organization ↔ our `Organization` (1:1). Store `workos_organization_id` on `Organization`.
- WorkOS User ↔ our `User` (1:1). Store `workos_user_id` on `User`; trust WorkOS for password, MFA, SSO/SAML claims, and lifecycle (deactivation, email change).
- AuthKit handles the login flow; LLteacher's session is a thin wrapper around the WorkOS session.
- WorkOS Directory Sync (SCIM) is **not** the path for course rosters — UW Canvas doesn't expose SCIM at the course level. Use Directory Sync only for instructor/admin provisioning at the org level if/when a partner org supports it.

**Canvas API — course & roster data plane**
- `Course` is a projection of a Canvas course. Store `canvas_course_id` (unique per `Organization.canvas_account_id`) and `last_synced_at`.
- `CourseMembership` is a projection of a Canvas enrollment. Store `canvas_enrollment_id`, raw `canvas_role` (e.g., `TeacherEnrollment`, `StudentEnrollment`, `TaEnrollment`), and a derived `role` enum.
- Canvas API token lives in `OrganizationCredential` (one per org, possibly one per Course if scoping is per-course).
- Sync model: pull on schedule (e.g., hourly) into a `CanvasSyncJob` row; later, subscribe to Canvas Live Events for near-real-time roster changes.
- LTI 1.3 launches authenticate via `LMSIntegration` (per-course deployment metadata: `iss`, `client_id`, `deployment_id`); the launch maps the `sub` claim to a `User` via `workos_user_id` or `email` and resolves a `CourseMembership` via the `context_id` claim.

**User identity reconciliation (the boring-but-critical case)**
When a Canvas enrollment is pulled before that user has ever logged in through WorkOS, we have an email but no `workos_user_id`. Options:
- Create a *pending* `User` row with `workos_user_id = NULL` and a `pending_canvas_login_hint`; reconcile on first WorkOS login by matching email.
- Or skip user creation until first LTI launch / WorkOS login; the enrollment row sits unresolved.

Recommendation: create the pending User. It lets instructors see the full roster before students have logged in.

### 3.5 Open design questions

1. **Conversation uniqueness.** Should `(user, section)` have at most one *active* (non-deleted) conversation? Current implicit answer is "yes, soft-delete enforces it"; make it explicit with a partial unique index.
2. **Prompt template inheritance.** Strict chain (section → homework → course → org), or composable (section *adds to* course)? Composable is more flexible but harder to debug. Recommendation: strict resolution + a `compose_with_parent: bool` flag on PromptTemplate.
3. **Material chunk storage.** pgvector in Postgres vs. external vector store. pgvector keeps ops simple and FERPA-easier (data doesn't leave UW infra). Recommendation: pgvector unless a PI needs a scale we can't hit.
4. **Migration of Sara's live data.** Backfill plan: one Organization ("UW Statistics"), one Course ("STAT 311, Fall 2025"), CourseMemberships generated from existing Teacher/Student rows. Reconcile to WorkOS at first login of each existing user.
5. **Hard-delete path.** FERPA may require true deletion on student request. Decide where the cascade stops (audit log usually exempted; conversation content not).
6. **Canvas role mapping precedence.** A user may have both `TeacherEnrollment` and a separate manual instructor role. Pick the *highest-privilege* role on conflict, or store the raw list and compute role per request?

---

## 4. Proposed Phasing

Not a commitment — a strawman for the team to react to.

**Phase 0 — non-breaking additions (current branch)**
- Add `Organization` and `Course` with a default "UW Statistics / STAT 311" row.
- Add `course_id` (nullable, populated from default) to `Homework`, `Conversation`.
- Introduce `OrgScopedQuerySet` mixin behind a feature flag; existing queries unchanged.

**Phase 1 — prompt + grading + telemetry**
- Add `PromptTemplate` with org/course/homework/section scope.
- Migrate `LLMConfig.base_prompt` into PromptTemplate; mark `base_prompt` deprecated.
- Add `Grade`, `LLMCallLog`.
- Refactor `Message` to (`role`, `content_type`, `agent`) with a backfill from `message_type`.

**Phase 2 — RAG + LMS**
- Add `CourseMaterial`, `MaterialChunk` (pgvector), `Citation`.
- Add `LMSIntegration`, `LTILaunch`; Canvas LTI 1.3 launch flow on a single test course.

**Phase 3 — compliance + multi-tenant cutover**
- Add `AuditEvent` middleware.
- Drop `Teacher` / `Student` in favor of `CourseMembership` (touches accounts views).
- Remove the default-tenant shim; require `organization` on all writes.

**Phase 4 — multi-agent (driven by Polya needs)**
- Add `AgentDefinition`, `ConversationPhase`.
- Implement the tutor/evaluator/profile-builder triplet on one Polya pilot course.

---

## 5. What to do next

1. Circulate this doc to Vani / Carlos / Anand / Sarah and at least one non-Sara PI (Arnold for Polya is the highest-signal review — most structurally divergent).
2. If the entity model survives that review, produce an ER diagram and a `models.py`-level sketch on this branch.
3. Decide tenancy enforcement (shared-schema vs. `django-tenants`) — that decision shapes Phase 0 substantially.
4. Confirm migration strategy for Sara's live data before Phase 0 lands.

---

## 6. ER Diagrams

Split into three views — identity/tenancy, content/config, and runtime — because one combined diagram is unreadable. Each Mermaid `erDiagram` block renders inline on GitHub. Polymorphic refs (`scope_id`, `citable_id`) and vector / jsonb columns are noted as strings; Mermaid ER doesn't model those natively.

### 6.1 Identity & Tenancy

WorkOS-backed identity, Canvas-backed course/roster, with one tenancy boundary at `Organization`.

```mermaid
erDiagram
    Organization ||--o{ Course : "owns"
    Organization ||--o{ OrganizationCredential : "stores"
    Course ||--o{ CourseMembership : "has roster"
    User ||--o{ CourseMembership : "enrolled in"
    Course ||--o| LMSIntegration : "connects via"
    LMSIntegration ||--o{ LTILaunch : "logs"
    User ||--o{ LTILaunch : "performs"
    OrganizationCredential ||--o{ LMSIntegration : "auths"

    Organization {
        uuid id PK
        string slug UK
        string name
        string workos_organization_id UK "auth tenant"
        string canvas_account_id "Canvas account / sub-account"
        bool requires_ferpa
        bool requires_hipaa
        string data_residency
        datetime created_at
    }
    User {
        uuid id PK
        string workos_user_id UK "WorkOS user (NULL while pending)"
        bytea email "AES-256-GCM ciphertext"
        bytea email_blind_index UK "HMAC-SHA256, lookup token"
        bytea netid "AES-256-GCM ciphertext (NULL for non-UW)"
        bytea netid_blind_index UK "HMAC-SHA256, lookup token"
        bytea display_name "AES-256-GCM ciphertext"
        datetime last_login_at
        bool is_pending "true until first WorkOS login"
    }
    Course {
        uuid id PK
        uuid organization_id FK
        string canvas_course_id "external Canvas id"
        string code "e.g. STAT 311"
        string term "e.g. 2026-A"
        string title
        bool is_active
        datetime last_synced_at
    }
    CourseMembership {
        uuid id PK
        uuid user_id FK
        uuid course_id FK
        string role "instructor|ta|student|observer|admin"
        string canvas_enrollment_id
        string canvas_role "raw Canvas role"
        datetime enrolled_at
        datetime dropped_at
        datetime last_synced_at
    }
    LMSIntegration {
        uuid id PK
        uuid course_id FK UK
        string provider "canvas"
        string lti_iss
        string lti_client_id
        string lti_deployment_id
        uuid api_credential_id FK
    }
    LTILaunch {
        uuid id PK
        uuid lms_integration_id FK
        uuid user_id FK
        string nonce UK
        string resource_link_id
        string role_claim
        datetime occurred_at
    }
    OrganizationCredential {
        uuid id PK
        uuid organization_id FK
        string provider "openai|anthropic|canvas|workos"
        string label
        string secret_ref "external secrets-manager ref"
        datetime rotated_at
    }
```

### 6.2 Content & Configuration

Homework structure, prompt templates with four-level scope, LLM configs, and course materials for RAG. `PromptTemplate.scope_type` + `scope_id` is the polymorphic owner; resolution walks section → homework → course → org.

```mermaid
erDiagram
    Organization ||--o{ LLMConfig : "owns"
    Organization ||--o{ PromptTemplate : "org defaults"
    Organization ||--o{ AgentDefinition : "defines"
    OrganizationCredential ||--o{ LLMConfig : "secret for"

    Course ||--o{ Homework : "assigns"
    Course ||--o{ PromptTemplate : "course-level"
    Course ||--o{ CourseMaterial : "materials"

    CourseMembership ||--o{ Homework : "authored by"
    CourseMembership ||--o{ CourseMaterial : "uploaded by"

    Homework ||--o{ Section : "contains"
    Homework ||--o| PromptTemplate : "homework override"
    Homework ||--o| LLMConfig : "uses"

    Section ||--o| SectionSolution : "has"
    Section ||--o| PromptTemplate : "section override (Sara level-2)"

    PromptTemplate ||--o{ PromptTemplate : "next version of"

    CourseMaterial ||--o{ MaterialChunk : "chunked into"

    AgentDefinition ||--o| PromptTemplate : "default prompt"
    AgentDefinition ||--o| LLMConfig : "default llm"

    LLMConfig {
        uuid id PK
        uuid organization_id FK
        string provider "openai|anthropic|claude_for_ed|openrouter|local"
        string model_name
        float temperature
        int max_completion_tokens
        uuid credential_id FK
        bool is_default
        bool is_active
    }
    PromptTemplate {
        uuid id PK
        string scope_type "org|course|homework|section"
        uuid scope_id "polymorphic owner"
        uuid previous_version_id FK
        int version
        text content
        bool compose_with_parent
        bool is_active
        datetime created_at
    }
    Homework {
        uuid id PK
        uuid course_id FK
        uuid created_by_id FK "CourseMembership"
        uuid prompt_template_id FK "nullable; inherits"
        uuid llm_config_id FK "nullable; inherits"
        string title
        text description
        datetime due_date
        datetime created_at
    }
    Section {
        uuid id PK
        uuid homework_id FK
        uuid prompt_template_id FK "nullable; level-2"
        int order
        string title
        text content
    }
    SectionSolution {
        uuid id PK
        uuid section_id FK UK
        text content
    }
    CourseMaterial {
        uuid id PK
        uuid course_id FK
        uuid uploaded_by_id FK "CourseMembership"
        string source_type "pdf|slides|transcript|syllabus|other"
        string title
        string original_filename
        jsonb upload_metadata
        datetime uploaded_at
    }
    MaterialChunk {
        uuid id PK
        uuid material_id FK
        int ordinal
        text text
        vector embedding "pgvector"
        int token_count
    }
    AgentDefinition {
        uuid id PK
        uuid organization_id FK
        string name "tutor|transcript_evaluator|profile_builder"
        text role_description
        uuid default_prompt_template_id FK
        uuid default_llm_config_id FK
    }
```

### 6.3 Runtime — Conversation, Grading, Audit

Conversation owns messages (now with strict `role` / `content_type`), submission/grade is split, citations are polymorphic across messages and grade feedback, audit + student profile + LLM call log sit alongside.

```mermaid
erDiagram
    Section ||--o{ Conversation : "threads"
    User ||--o{ Conversation : "owns"
    Course ||--o{ Conversation : "scopes (denormalized)"

    Conversation ||--o{ Message : "contains"
    Conversation ||--o| Submission : "produces"
    Conversation ||--o{ ConversationAgent : "active agents"
    AgentDefinition ||--o{ ConversationAgent : "instance of"

    Message ||--o| LLMCallLog : "telemetry"
    Message ||--o{ Citation : "cites"
    PromptTemplate ||--o{ Message : "pinned version"
    AgentDefinition ||--o{ Message : "produced by"

    Submission ||--o{ Grade : "graded"
    Grade ||--o{ Citation : "cites"
    CourseMembership ||--o{ Grade : "grader"

    MaterialChunk ||--o{ Citation : "cited"

    User ||--o{ StudentProfile : "has"
    Course ||--o{ StudentProfile : "in"

    Organization ||--o{ AuditEvent : "scopes"
    User ||--o{ AuditEvent : "actor"

    Conversation {
        uuid id PK
        uuid section_id FK
        uuid user_id FK
        uuid course_id FK "denormalized for org guard"
        string conversation_type "recall|discovery|critical_thinking|tutor|evaluator"
        string phase "understand|plan|execute|reflect (Polya)"
        bool is_deleted
        datetime deleted_at
        datetime created_at
    }
    ConversationAgent {
        uuid id PK
        uuid conversation_id FK
        uuid agent_definition_id FK
        datetime joined_at
    }
    Message {
        uuid id PK
        uuid conversation_id FK
        string role "user|assistant|system|tool"
        string content_type "text|code|file_upload|tool_call|tool_result"
        text content
        uuid agent_id FK "nullable"
        uuid prompt_template_version_id FK "nullable; pins prompt"
        datetime timestamp
    }
    LLMCallLog {
        uuid id PK
        uuid message_id FK UK
        string provider
        string model
        string provider_request_id
        int input_tokens
        int output_tokens
        int cost_cents
        int latency_ms
        datetime occurred_at
    }
    Submission {
        uuid id PK
        uuid conversation_id FK UK
        datetime submitted_at
    }
    Grade {
        uuid id PK
        uuid submission_id FK
        uuid grader_id FK "CourseMembership; NULL if AI"
        bool graded_by_ai
        float score
        jsonb rubric
        text feedback
        datetime graded_at
    }
    Citation {
        uuid id PK
        string citable_type "message|grade"
        uuid citable_id "polymorphic"
        uuid material_chunk_id FK
        int span_start
        int span_end
    }
    StudentProfile {
        uuid id PK
        uuid user_id FK
        uuid course_id FK
        text summary "regenerable; not authoritative"
        jsonb mastery_signals
        datetime last_regenerated_at
    }
    AuditEvent {
        uuid id PK
        uuid organization_id FK
        uuid actor_user_id FK
        string action
        string target_type
        uuid target_id
        string ip
        datetime occurred_at
    }
```

### 6.4 What the diagrams deliberately leave out

- **`CanvasSyncJob` / `WorkOSWebhookEvent`** — operational tables for the sync workers. Belong in a separate "integrations runtime" doc, not the data model.
- **Django session / auth_token tables** — handled by WorkOS + Django auth; not part of the domain model.
- **Notifications, email outbox** — out of scope until a PI asks for them.
- **Per-tenant feature flags** — likely lives on `Organization` as a JSONB column, but the schema isn't worth diagramming.
- **Materialized views for instructor dashboards** — derived; design after the base model is real.

