# M4: Conversations, Chat & R Execution Parity — PR Sequencing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan issue-by-issue (one fresh subagent per GitHub issue, task review after each, whole-branch review per PR). Scope: GitHub milestone 4 (20 open issues) + the M3 issues that are blocked on M4 work. Broken into 4 sequential, independently-mergeable PRs. Ends with a full epic acceptance pass against issue #30's own checklist.

## Context

Issue [#30](https://github.com/uw-ssec/llteacher/issues/30) is the M4 epic. It already ships with a dependency chain, a set of cross-cutting invariants, and an end-to-end acceptance checklist — it's a de facto plan. This document operationalizes it: it orders the 20 M4 issues (plus 4 coupled M3 issues) into 4 PRs that respect the real dependency graph, so each PR lands working, testable software and nothing gets built on top of an unresolved design question.

**Two things discovered during research that affect execution, not just planning:**

1. **CLAUDE.md is stale.** It describes a Django project (views, decorators, `manage.py`). The actual repo on `staging` is a TypeScript monorepo (`apps/web` = Hono API + Drizzle, `apps/admin` = React admin, `packages/ui` = shared components). All file paths below are relative to repo root on that stack. The Django tree under `apps/conversations`, `apps/llm` etc. referenced inside issue bodies is *reference material* for porting behavior, not code to modify.
2. **The `m4-conv-chat` worktree needed a base-branch fix before coding started.** `EnterWorktree` created it from `origin/llteacher01` (default branch), which was still the old Django tree — not from `staging`, which has all the M2/M3 work (schema, repositories, routes) this epic builds on. Fixed by resetting the worktree branch to `staging`'s pulled tip (`f052602`) before Task 1; baseline `npm test` was green (311 passed, 0 failed) before any implementation began.

## Execution Protocol

**Run this plan with `superpowers:subagent-driven-development`** — dispatch one fresh subagent per issue (not per PR), in the dependency order given in each PR section below. Within a PR, issues with no dependency on each other in that same PR may be dispatched in parallel (e.g. #25 and #26 in PR 2); issues that depend on a sibling in the same PR (e.g. #6 needs #4) must be sequenced after it. Review each subagent's output before dispatching the next dependent one. A PR is done — and mergeable — only once every issue in its table is closed and the PR-level "Primary files" area has one coherent commit history.

**Every subagent, for every issue, must do all of the following — in order — before it reports done:**

1. **Open the live issue:** `gh issue view <N> --repo uw-ssec/llteacher --json number,title,body,assignees` — the issue body is the source of truth for requirements; this plan's table summarizes it, but re-read the full body (it may have changed since this plan was drafted, as happened with #141).
2. **Assign it to the user:** `gh issue edit <N> --repo uw-ssec/llteacher --add-assignee KshitijDani` (do this before starting work, not after).
3. **Implement every requirement checkbox in the issue body** — not just the ones summarized in this plan's tables. Follow the issue's own "Code Framework" / "Files to touch" / "Pattern to imitate" sections where present; they name exact files and signatures.
4. **Run the issue's own verification/acceptance criteria** — the Vitest files and commands named in that issue's "Testing Strategy" section (or, if absent, the nearest existing test file for the area touched). Do not mark anything done on a failing or skipped test.
5. **Commit the code** — reference the issue number in the commit message (e.g. `feat(chat): persist messages (#3)`), following this repo's existing commit message style (`git log --oneline` for recent examples).
6. **Check off every completed requirement box on the live GitHub issue** — re-fetch the current body, flip each satisfied `- [ ]` to `- [x]`, and push it back with `gh issue edit <N> --body-file <tmpfile>` (do a string diff first; never blanket-overwrite a box you didn't actually verify). If a requirement genuinely can't be satisfied yet (e.g. blocked on a cross-issue decision), leave it unchecked and say why in a comment (`gh issue comment <N> --body "..."`) rather than checking it prematurely.
7. **Verify before reporting done:** re-view the issue (`gh issue view <N>`) and confirm every box that should be checked is checked, the assignee is set, and the referenced commit(s) exist on the branch. Only then report the issue complete back to the orchestrating session.

This protocol applies to every issue in every PR section below — it isn't repeated per-issue in the tables to keep them scannable.

## Cross-cutting invariants (hold in every PR below)

Copied from #30's own "Integration & Verification Strategy" — every PR's tests must respect these, not just the PR's own issue list:

- **Org/course scoping:** every conversation/message/transcript query filters by `organizationId` AND `courseId`. Add/use a shared `enforceOrgCourseScope(db, context)` helper (issue #29 introduces `apps/web/src/lib/instructor-authz.ts` — reuse it, don't fork a second helper).
- **Prompt template versioning:** a conversation pins `promptTemplateVersionId` at start (#25); never re-resolved per-message.
- **LLM config stability:** the config resolved at conversation start is cached on the conversation row, never re-resolved per-message (#26).
- **Soft-delete semantics:** soft-deleted conversations are excluded from student/public lists, included (flagged) in instructor/audit views. Defined once in the service layer, tested at every call site.
- **Message ordering:** strictly timestamp-ordered, no gaps, safe under concurrent writes.
- **Streaming invariants:** `/api/chat` never leaves a partial message un-flagged if the connection drops (transactional writes); tool-call turns stay valid; response is UIMessage-stream compatible.
- **Authorization:** students read/write only their own conversations; instructors read only their course's conversations (+ their own test conversations); never rely on client-supplied IDs alone.

## Dependency graph (why this order)

- **Schema is already done** — issue #2 (`conversations`/`messages` tables) shipped in M2 and is closed. Nothing in M4 is schema-blocked.
- **#3 (persist messages) + #5 (CRUD routes)** are the true foundation — every UI and lifecycle issue reads/writes through them.
- **#4 (list UI)** needs #3 (data to list) + #5 (list endpoint). **#6 (inline rename)** needs #4 (surface to rename in) + #5 (PATCH route). These four plus their wrapper epic **#1** form one cohesive slice.
- **#25 (prompt assembly)** and **#26 (LLM config resolution)** are independent of each other and of #3/#5, but **#27 (conversation lifecycle)** explicitly says its greeting is "adapted to the prompt builder" — so #27 needs #25 (and benefits from #26 for real model calls).
- **#143 (harden /api/chat)**'s two substantive requirements — "resolve the model from org's `llm_configs`" and "server-held system prompt" — are literally #26's and #25's outputs. Building #143 before #25/#26 exist means touching `chat.ts` twice; sequence it right after them.
- **#28 (WebR)** needs #3 (persist `code_execution` messages) and #25 (replay code output into prompt context).
- **#29 (transcript viewer)** needs #27 (real conversation data to view — #27 explicitly says #22/#23 have "zero reachable production data" until it ships) and #28 (to render R output in transcripts).
- **#80 (hints)** and **#168 (mark_section_complete)** both hook into the prompt builder (#25) and are evaluated by **#89**, so both precede #89.
- **#96, #88, #90** are hardening/instrumentation layered on top of persistence (#3) and prompting (#25) — safe to do last, and #90's flagged examples explicitly feed #89's eval set, so they belong in the same PR.
- **M3 coupling:** #22 and #23 are code-complete (merged in PR #154) but unverifiable until #27 creates real conversations — #27's own last requirement is to verify and close them. #23's transcript drill-in nav is blocked on #29. #128 is a design decision that #27's delete-and-restart behavior needs an answer to (what happens to an existing submission when a student restarts a section) — resolve it *alongside* #27, not after. #167 explicitly states "do not build ahead of" #128's decision.
- **#165 (M3 progress widgets) is deliberately excluded** — its remaining checklist items (student-surface wiring, export) have no M4 dependency.

---

## PR 1 — Persisted Tutor Conversations: CRUD, List UI, Rename, Chat Robustness

**Delivers:** students can create, list, rename, and persist tutor (course-scoped, non-section) conversations across reloads. Existing chat surface no longer white-screens on bad model output.

| Issue | Title | Key requirements |
|---|---|---|
| [#3](https://github.com/uw-ssec/llteacher/issues/3) | persist user/assistant messages | `/api/chat` accepts/returns `conversationId`; user message persisted before model call; assistant message persisted on stream completion (full final state); ownership check; idempotent against disconnect/retry |
| [#5](https://github.com/uw-ssec/llteacher/issues/5) | tutor conversation CRUD routes | `GET /api/conversations?courseId&kind=tutor`, `POST`, `PATCH` (title), `DELETE`; ownership → 404 not 403; Zod validation, title trim + ~100 char cap |
| [#4](https://github.com/uw-ssec/llteacher/issues/4) | tutor-conversations list UI | list shows title/timestamp/preview; "New conversation"; select-to-open; empty state; responsive to existing sidebar pattern |
| [#6](https://github.com/uw-ssec/llteacher/issues/6) | inline rename | click/keyboard → edit mode; Enter saves/Escape cancels/blur saves; optimistic update + revert-on-fail; a11y (`aria-label`, focus, keyboard-reachable); owner-only affordance |
| [#1](https://github.com/uw-ssec/llteacher/issues/1) | epic wrapper | closes automatically once #3/#4/#5/#6 land — verify its own acceptance bullets (list, create, rename, persist-across-reload, owner-only) end-to-end |
| [#141](https://github.com/uw-ssec/llteacher/issues/141) | typed tenancy errors | **scope is now narrow**: wire `TenancyMismatchError` → 404 mapping specifically for `createConversation`/`appendMessage` in `repositories/conversations.ts` when #5 wires them to routes. (The `createSubmission`/`recordGrade` call sites are resolved differently or M5-scoped — do not touch.) |
| [#144](https://github.com/uw-ssec/llteacher/issues/144) | chat crash / silent failures | runtime-validate untrusted tool `input` before render (`packages/ui/src/generative/render.tsx:32`, `apps/web/src/client/App.tsx:129`) using the deny-by-default pattern `parseCourseRole` already uses; add an ErrorBoundary / route `errorElement`; surface `useChat`'s `error`/`status==="error"` with a retryable row wired to `regenerate`; disable send while streaming (`App.tsx:175`, wire `Composer`'s `disabled`, `ConversationView.tsx:116`) |

**Primary files:** `apps/web/src/server/routes/chat.ts`, `apps/web/src/server/routes/conversations.ts` (new), `apps/web/src/server/repositories/conversations.ts`, `apps/web/src/client/App.tsx`, `apps/web/src/client/views/TutorConversationsList.tsx` (new), `apps/web/src/client/hooks/useTutorConversations.ts` (new), `packages/ui/src/components/EditableTitle.tsx` (new), `packages/ui/src/generative/render.tsx`.

**Why #144 here, not later:** it fixes the *existing* single-chat surface, and #4 is about to add a second UI surface reading the same message data — better to land the crash/error-boundary fix before there are two surfaces to keep in sync.

---

## PR 2 — Section-Aware Prompting, LLM Config Resolution, Conversation Lifecycle

**Delivers:** the chat is no longer hardcoded (prompt or model); sections have a real start/restart lifecycle; the submission-uniqueness design gap is closed; M3's submission flow and dashboard get verified against real data for the first time.

| Issue | Title | Key requirements |
|---|---|---|
| [#25](https://github.com/uw-ssec/llteacher/issues/25) | section-context prompt assembly | pure `prompt.ts` builder module (config `base_prompt` + homework/section title+content + history → system prompt); tutor guardrail preserved verbatim; history replay parity (user/assistant roles, code fenced) once #3 lands; route template lookup through one resolver function; **Vitest snapshot proving solutions never enter the student prompt** |
| [#26](https://github.com/uw-ssec/llteacher/issues/26) | per-homework LLM config resolution | resolution order: homework `llm_config_id` → org default (`is_default && is_active`); provider client built per-request (model id, base URL, temperature, max tokens); API keys resolved from `organization_credentials` secret refs (never plaintext); graceful failure with logged UUID on missing/invalid config |
| [#27](https://github.com/uw-ssec/llteacher/issues/27) | conversation lifecycle | `POST /api/sections/:id/conversations` creates conversation + canonical greeting message (via prompt builder); delete-and-restart soft-deletes current + creates fresh conversation for same section in one action; `type` column distinguishes student vs. instructor-test conversations; access matrix (owner/instructor read, owner-only write); **last requirement: once this ships, verify #22 and #23 end-to-end against real data and close them** |
| [#143](https://github.com/uw-ssec/llteacher/issues/143) | harden `/api/chat` | rate limit per user; request-size cap (`chat.ts:86`); tenancy binding — require conversation/section id, guard via `courseScopeFromAuthContext`, resolve model from #26 instead of hardcoded fallback (`chat.ts:96`); server-held system prompt (client can't override via crafted history — academic-integrity bypass fix); history windowing; `AbortSignal.timeout`; 400 vs 503 split; map provider 429 → retryable client error |
| [#128](https://github.com/uw-ssec/llteacher/issues/128) *(M3)* | resolve submission uniqueness/resubmission semantics | **design decision, resolve before/alongside #27's delete-and-restart implementation.** Answer: does delete-and-restart on an already-submitted section (a) supersede the existing submission (re-point at new conversation) or (b) implicitly un-submit? Then add the DB-level constraint that actually enforces the chosen answer (current schema doesn't survive soft-delete-and-recreate). Feed the answer directly into #27's delete-and-restart requirement above. |
| [#22](https://github.com/uw-ssec/llteacher/issues/22) *(M3)* | section submission flow | already merged (PR #154) — **re-run its Vitest suite + manual walk now that #27 produces real conversations**; confirm resubmit-in-place still behaves per #128's resolved semantics; close the issue |
| [#23](https://github.com/uw-ssec/llteacher/issues/23) *(M3)* | submissions dashboard | already merged except one box — **verify the real-data aggregation now that #27 exists**; leave the "drill-in navigation to transcript viewer" checkbox open (blocked on #29, PR 3) |

**Primary files:** `apps/web/src/lib/prompts.ts` (new), `apps/web/src/lib/llm-config.ts` (new), `apps/web/src/db/schema/conversations.ts` (new — split out of `content.ts`/`runtime.ts` per #27), `apps/web/src/lib/conversations.ts` (new service layer), `apps/web/src/server/routes/conversations.ts` (extend from PR 1), `apps/web/src/server/routes/chat.ts`, `apps/web/src/db/schema/runtime.ts` (submission/conversation constraint per #128's decision).

**Coordination note:** write #128's decision as a short design note (issue comment or `docs/architecture/` addendum) before writing #27's delete-and-restart code — this is the one place in the epic where a product decision, not just code, is the blocker.

---

## PR 3 — R Execution & Instructor Transcript Viewer

**Delivers:** students can run R inline and have it discussed by the tutor; instructors can open any transcript from the submissions dashboard drill-in (closing #23's last checkbox).

| Issue | Title | Key requirements |
|---|---|---|
| [#28](https://github.com/uw-ssec/llteacher/issues/28) | WebR R execution | `useWebR` hook (lazy dynamic import, init status, package install); `useRExecution` hook (stdout/result/plots — decide canvas vs. PNG `<img>` and document it); R-mode composer submits `code` message, execution persists as `code_execution` message; replay into LLM context as fenced blocks; `CodeBlock` output slot renders inline (errors distinct); graceful degradation when WebR fails to load |
| [#29](https://github.com/uw-ssec/llteacher/issues/29) | instructor transcript viewer | route from submissions-dashboard drill-in (per-cell conversation list → transcript); renders full history (markdown, generative-UI tool parts read-only, R code+output, system messages distinct); soft-deleted conversations viewable-but-flagged; instructor-of-course-only access, other instructors' test conversations excluded; audit-event emission point (TODO hook until M9 middleware exists); no edit affordances |
| [#80](https://github.com/uw-ssec/llteacher/issues/80) | hint semantics | explicit-action model (button, not heuristic classification); persist hint events (conversation+section scoped); sidebar hint count from server state, not fixture; per-section hint budget decision recorded even if "unlimited"; prompt-builder integration requests scaffolded response, never solution |
| [#168](https://github.com/uw-ssec/llteacher/issues/168) | `mark_section_complete` tool | tool exposed only on section-kind conversations (not tutor-kind); invocation persisted with triggering message; surfaced as a suggestion, never auto-submits, conversation stays usable after; prompt wording tunable per LLM config |

**Primary files:** `apps/web/src/client/hooks/useWebR.ts` (new), `apps/web/src/client/hooks/useRExecution.ts` (new), `packages/ui/src/generative/renderers/CodeExecution.tsx` (new), `apps/web/src/server/routes/instructor/transcripts.ts` (new), `apps/admin/src/client/views/TranscriptListView.tsx` / `TranscriptDetailView.tsx` (new), `apps/web/src/lib/instructor-authz.ts` (new — the org/course-scope helper referenced in the cross-cutting invariants above), `apps/web/src/server/routes/chat.ts` (executeRCode + markSectionComplete tools).

**Closes:** #23's remaining checkbox once #29's drill-in route exists — update `SubmissionsView.tsx` to link into `TranscriptDetailView`.

---

## PR 4 — Reliability, Safety & Research Instrumentation + Epic Acceptance

**Delivers:** production-hardening (streaming resilience, token-budget management), the answer-leakage eval harness, student feedback loop, M3's auto-submit (now unblocked), and the full epic acceptance pass.

| Issue | Title | Key requirements |
|---|---|---|
| [#96](https://github.com/uw-ssec/llteacher/issues/96) | streaming resilience | interrupted stream persists partial + flags it; client shows "interrupted — continue?" (requests continuation, not duplicate turn); client idempotency key + server dedupe window; failed send stays in composer with retry; two-tabs-same-conversation = last-writer-wins, no realtime sync (recorded non-goal); fault-injecting mock transport test |
| [#88](https://github.com/uw-ssec/llteacher/issues/88) | context-window management | token-budget the assembled prompt (system+section+history within model window + response headroom); recent-window + rolling summary strategy (simple truncation acceptable v1 fallback); code/`code_execution` messages get recency-aware treatment; per-model-aware window sizes; boundary + no-leakage-through-summary tests |
| [#89](https://github.com/uw-ssec/llteacher/issues/89) | answer-leakage eval harness | checked-in eval set (adversarial + normal prompts); `npm run tutor:eval` runs real prompt builder + judge pass; baseline scores + regression-fail threshold; solution-leakage cases double as #25's structural unit fixtures; deterministic/recorded mode for CI |
| [#90](https://github.com/uw-ssec/llteacher/issues/90) | student feedback flag | per-message flag affordance (reason + optional comment), one per message per student; instructor review surface; flagged examples exportable into #89's eval set |
| [#167](https://github.com/uw-ssec/llteacher/issues/167) *(M3)* | auto-submit overdue sections | scheduled job submits past-due sections with an active-but-unsubmitted conversation; distinguishable `source` column (`student`\|`auto`); idempotent re-runs; observable run counts; **built on #128's resolved uniqueness semantics from PR 2 — do not build ahead of it (this was explicitly called out in the issue)** |

**Primary files:** `apps/web/src/lib/tokenCounter.ts` (new), `apps/web/src/db/schema/content.ts` (stream-session tracking, `responseFeedback`, `conversation_summary`), `apps/web/src/server/routes/chat/resume.ts` (new), `apps/web/src/server/jobs/cleanup-stale-streams.ts` (new), `apps/web/src/server/jobs/auto-submit-overdue.ts` (new), `evals/tutor-behavior.ts` + `evals/datasets/` + `evals/scoring/` (new), `apps/web/src/server/routes/feedback.ts` (new), `apps/admin/src/client/views/FeedbackDashboard.tsx` (new).

### Final step of PR 4: Epic acceptance test against #30's own criteria

Run the full regression suite #30 lists:
```bash
npm test -- apps/web/src/lib/prompts.test.ts
npm test -- apps/web/src/lib/llm-config.test.ts
npm test -- apps/web/src/lib/conversations.test.ts
npm test -- apps/web/src/server/routes/chat.test.ts
npm test -- apps/web/src/server/routes/conversations.test.ts
npm test -- apps/web/src/server/routes/instructor/transcripts.test.ts
npm test -- apps/web/src/client/hooks/useWebR.test.ts
```
All must pass, >85% line coverage on new code, no skipped tests.

Then manually walk #30's **End-to-End Acceptance Checklist** line by line (org scoping via 2-org/2-course cross-access attempt; prompt-version pinning via mid-conversation template edit; LLM config fallback chain across org/course/homework-level configs; streaming continuity via a mid-response connection drop; soft-delete visibility across student/instructor/audit views; transcript-list performance at 500 conversations, <500ms, paginated; WebR infinite-loop timeout at 30s + recovery; cross-user and cross-org authorization isolation attempts). Record pass/fail against each bullet in the epic issue before closing #30.

---

## Known soft/external dependencies (flagged, not blocking)

- **#45** (LLM call logging, M8, still open) — #88 and #89 both say "logged via #45." Implement local/console logging now; rewire to #45's logging surface when M8 ships. Don't block on it.
- **#41** (RAG retrieved chunks, M7) — referenced in #88's token-budget formula ("system + section context + retrieved chunks (#41)"). Out of scope; budget for it in the token math as a documented future addend, not a blocking dependency.
- **#78** (visibility decision, referenced by #80 and #90) — assume default-open instructor visibility for hints/flags until #78 resolves; note the assumption in both issues' PRs so it's easy to revisit.

## Verification approach

- **Per-PR:** run the Vitest files named in each issue's own "Testing Strategy"/"Files to touch" section (already written into each issue body — pull it during implementation rather than re-deriving); typecheck + lint if the workspace defines those scripts.
- **PR 2 specifically:** confirm #128's chosen constraint actually rejects the soft-delete-and-recreate double-submission scenario reproduced in PR #127's review — this is the one invariant that has no existing test to extend.
- **PR 3 specifically:** manually verify the admin drill-in link from `SubmissionsView` actually opens the right conversation (cross-app navigation, easy to get an ID or route param wrong).
- **PR 4 / final:** the full regression suite + manual acceptance checklist above, plus updating #30's own checkbox list in GitHub as each child issue closes.
