# M4: Conversations, Chat & R Execution Parity — PR Sequencing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan issue-by-issue (one fresh subagent per GitHub issue, task review after each, whole-branch review per PR). Scope: GitHub milestone 4 (21 issues as of the 2026-08-11 sync — see below) + the M3 issues that are blocked on M4 work. Broken into 4 sequential, independently-mergeable PRs. Ends with a full epic acceptance pass against issue #30's own checklist.

## 2026-08-14 sync check (PR2 completion pass)

**Start here if you're picking up where this pass left off.** Re-verified the plan against live GitHub + repo state, and closed out PR2's remaining work:

- **PR1 (#212) merged into `staging`** as squash commit `7d49636` — confirmed live. `m4-conv-chat-pr2` has since been merged with `origin/staging` (not rebased — squash-merges break rebase's history-matching, so a merge commit was the correct tool; see this session's own commentary if replaying that decision).
- **Core PR2 issues are fully implemented**: #25, #26, #178, #27, #143, #248 (plus M3's #22/#23, verified against real data, and #128, already closed via Cordero's #247). Every requirement checkbox on all six is already checked on GitHub. **Do not close these issues directly** — reference them in PR2's own PR body (`Closes #25, #26, #178, #27, #143, #248`) so they auto-close on merge, per this epic's standing convention.
- **Of PR2's table below, four of the five secondary issues are now also implemented**: #274 (client Stop control — the server-side timeout half was already done; added `onStop` to `ConversationView`, wired both `useChat` instances' own `stop()`), #279 (collapsed 3 of 4 redundant per-turn DB round-trips via a shared `assertConversationInScope` + `skipOwnershipCheck` opt-out), #305 (moved `sectionGreeting`/the `Section N: Title` template out of `sectionConversations.ts` into `lib/prompts.ts`), #312 (extracted `resolveConversation`/`classifyTurn` from `chatHandler`, both now independently testable — `classifyTurn` with zero mocks; documented rather than consolidated the `db.batch`/`runAtomically` question, matching the issue's own "consolidate or document" framing).
  - **Scoped down, not fully done**: #312's full "31-place stale-comment sweep" was narrowed to only the comments the issue calls factually false — those had already been corrected as a side effect of #268 landing, so no further edits were needed there. #305's requirement 3 (generate the tool-usage paragraph from `TOOLS` instead of hand-writing it in `DEFAULT_SYSTEM_PROMPT`) is deliberately deferred to PR 3, which adds the second and third tools (`executeRCode`, `markSectionComplete`) — with exactly one tool today, there's no real drift for the abstraction to prevent yet.
  - #279's own "Promise.all the rate-limit check and conversation resolution" suggestion was deliberately NOT done: `reserveRateLimitSlot` and conversation resolution both have real side effects now (an atomic increment; a possible new conversation/section-conversation row) — running them concurrently would mean a 429'd request could still leave a freshly-created conversation behind. The safe 3-of-4 round-trip reduction above captures most of the issue's value without that risk.
- **#282 removed from PR2's active scope**: checked live and it is **not tagged to the M4 milestone at all** (`milestone: null`) despite appearing in this table below — the table itself may be stale on this point, or #282 was deliberately untagged and never reconciled. Its "global in-flight cap" requirement also needs new infra (a DB-backed in-flight counter with a staleness cutoff, or a Durable Object) this app has never used — a real architectural decision, not a PR2 side effect. Left in the table below for visibility, but not built this pass; milestone-tag it and scope it on its own before picking it up.
- **New issue #313** (`chat_rate_limit_windows` unbounded growth — no cleanup path) is tagged M4 but was in no PR's table. Added to PR 4's table below: its own issue text names PR 4's not-yet-built `apps/web/src/server/jobs/` scheduled-job infra as its natural home, so it can't land standalone here.
- **Full-milestone audit**: cross-checked all 79 M4-tagged issues (`gh issue list --milestone "M4..." --state all`) against every PR table in this doc. Several sit OPEN on GitHub but are already code-complete via commits already on this branch, part of PR1's own addendum work landing ahead of this doc being updated for them: #261, #262, #265, #271, #272, #276, #284, #296–299. No new work needed for any of these — they'll close whenever the PR that already contains their fix references them. No other gaps found.

## 2026-08-12 sync check (pre-PR-2 kickoff)

**Start here if you're picking up PR 2.** Re-verified the plan against live GitHub + repo state before handing off:

- **PR 1 (#212) is still open**, not yet merged to `staging` — `mergeable: MERGEABLE`, CI green on its latest commit. Do not wait for the merge: keep committing PR 2 work to the same `worktree-m4-conv-chat` branch/worktree (`/Users/kshitijdani/Desktop/SSEC/llteacher/.claude/worktrees/m4-conv-chat`) — it already contains everything #212 has, plus everything `staging` has picked up in the meantime (see next point). The GitHub merge is a formality that can happen whenever Cordero re-approves; it does not gate starting PR 2's code.
  - #212's last commit as of this sync: `3c291f4 fix(chat): route kind:section through startSectionConversation (#259)` — fixed Cordero's one blocking review finding. Review re-requested from `cdcore09`.
- **Cordero landed a real PR against this milestone since the 08-11 sync**: [#247](https://github.com/uw-ssec/llteacher/pull/247) `feat(db): submission uniqueness + section conversation lifecycle (#128, #27)`, merged into `staging` 2026-08-12, and pulled into this worktree via a `staging` merge. This is a bigger plan delta than it looks:
  - **#128 (M3, submission-uniqueness design decision) is now CLOSED.** The restart-then-resubmit semantics PR 2's table assumed still-open are resolved and implemented (`restartSectionConversation` returns a `voidedSubmission`; see `apps/web/src/server/repositories/sectionConversations.ts`).
  - **#27's implementation already exists** — `startSectionConversation`, `restartSectionConversation`, `getActiveSectionConversation`, etc. in `repositories/sectionConversations.ts` + their routes — but **issue #27 itself is still OPEN**. Read it live before assuming what's left; at minimum its "verify #22/#23 against real data" closing requirement was blocked until today, because `/api/chat`'s `kind:"section"` path never actually called into this code (that was #259, just fixed in `3c291f4`). #27's lifecycle is now reachable from real chat traffic for the first time — #22 and #23 (both still OPEN) can likely be verified and closed as PR 2's first concrete step, ahead of #25/#26/#178.
  - **PR 2's issue table below is stale on #27 and #128 as a result** — treat #25, #26, #178, #143 as the real remaining net-new build work; treat #27/#22/#23 as a verify-and-close pass on code that already landed.
- **New issue not in the original plan or the 08-11 sync: [#248](https://github.com/uw-ssec/llteacher/issues/248)**, milestone M4, unassigned, created after 08-11. Title: "design: what the student is told (and can recover) when restarting a section." It's the disclosure/UX half of what #128 (data semantics, closed) and #27 (the bare "restart affordance with confirm" checkbox) leave unanswered — namely that a restarted conversation is currently unreachable by *anyone* (soft-deleted, filtered out of every read path) and there's no submission history to point a "your prior attempt is still there" claim at. Read #248's full body before building #27's restart UI — it may change what that confirm dialog is allowed to say.
- **#178 (LLMoxie API key + LiteLLM wiring) is in scope for this pass** — Kshitij wants it implemented, not just reserved. Sequence it directly after #26 per the original dependency note (same `ai.ts` provider-dispatch switch #26 introduces — building both at once risks a merge conflict inside one function).
- All other PR 2 issues (#25, #26, #143) unchanged in state — still OPEN, unassigned, original dependency reasoning holds.

**Suggested PR 2 order given the above:** #22 → #23 (verify #27's already-landed lifecycle against real data, now unblocked by #259) → re-read live #27 and check off/close what's actually satisfied → #248 (resolve the restart-disclosure design question, since #27's remaining "restart affordance" checkbox needs it) → #25 → #26 → #178 → #143.

**Verification commands that worked this session** (apps/web has real-DB-gated tests that need a live Neon URL and a longer timeout than the 5000ms default — remote-DB latency, not flakiness):
```bash
# typecheck (whole monorepo, from repo root)
npm run typecheck

# fast suite, no real DB (from apps/web/)
npx vitest run

# real-DB-gated suite (from apps/web/, DATABASE_URL sourced from .dev.vars)
export DATABASE_URL=$(grep '^DATABASE_URL=' .dev.vars | sed 's/^DATABASE_URL=//; s/^"//; s/"$//')
npx vitest run --testTimeout=30000
```

## 2026-08-11 sync check (post PR-1-merge-into-staging)

PR 1 landed all 7 of its issues (#3/#5/#4/#6/#1/#141/#144 — [PR #212](https://github.com/uw-ssec/llteacher/pull/212), pending merge to `staging`). Before starting PR 2, re-verified the plan against live GitHub state:

- **A separate PR (#209, "TA capabilities") merged into `staging` in the interim**, closing issue #172 among others. Confirmed #172 is **milestone 5** (Admin Console & LLM Config Parity), not M4 — its TA-role/auth-gating changes don't touch any M4 primary file. No plan change needed; `staging` was merged into this branch cleanly (see `deabd36`).
  - One incidental, non-blocking note for whoever eventually verifies #23 (submissions dashboard) in PR 2: that merge added a `homeworkStatus` field to `getHomeworkSubmissionsMatrix`'s and `getSectionAnswer`'s return shape (unreleased-content gating, #172's audit). Purely additive.
- **New issue [#178](https://github.com/uw-ssec/llteacher/issues/178)** ("Add LLMoxie API key to the repo") appeared in the M4 milestone (created 2026-08-10, wasn't there when this plan was first drafted). Per human decision, folded into **PR 2, sequenced directly after #26** — see PR 2's table and Primary files below.
- All other M4 issues and the 4 M3-coupled issues (#128, #22, #23, #167) unchanged in state/milestone — original dependency reasoning still holds.

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

### PR 1 addendum (2026-08-12): non-blocking findings pulled forward from the round-3 audit

Cordero's round-3 re-audit of #212 filed 50 issues (#263–#312): 4 Critical,
39 Major, 7 Minor/Enhancement. 11 were blocking and are already fixed (see
the sync note above this table). Of the remaining 39, the 17 below are
worth finishing in *this* PR rather than deferring — either because
Cordero's own review text explicitly said "I'd pull forward," or because
they're direct continuations of code the 11 blocking fixes already
touched this session (same file/function; cheaper to close now than to
re-open the area for a second pass later). The rest are distributed into
PR 2/PR 4 below — nothing in this batch maps to PR 3's WebR/transcript
scope.

| Issue | Title | Why now |
|---|---|---|
| [#285](https://github.com/uw-ssec/llteacher/issues/285) | document the five new conversation routes for consumers | **Critical**, and Cordero's own "I'd pull forward" list. Three other CDI teams integrate against these routes with zero consumer docs today — path/method/auth/request-response shape/error codes for each. |
| [#280](https://github.com/uw-ssec/llteacher/issues/280) | wire conversation and message pagination in the client | Cordero's "pull forward" list. Server already paginates (#224); the client never sends `limit`/`before` or offers load-more, so the 51st conversation is unreachable. Fix with #281. |
| [#281](https://github.com/uw-ssec/llteacher/issues/281) | conversation list cursor drops rows; no tiebreaker or index | Cordero's "pull forward" list. The `updatedAt` cursor #280 would page on isn't safe yet — no tiebreaker, no supporting index. |
| [#295](https://github.com/uw-ssec/llteacher/issues/295)–[#300](https://github.com/uw-ssec/llteacher/issues/300) | the accessibility set: rename pencil not exposed to AT (nested interactive inside `role=button`), rail contrast fails WCAG, rename-pencil target is half the WCAG 2.5.8 minimum, rename-exit/error-boundary destroys keyboard focus, no main landmark/skip link past two nav rails, streamed output never announced to screen readers | Cordero's "pull forward" list, and directly continues #270 (composer focus) — same audit dimension, same PR, same review pass. |
| [#273](https://github.com/uw-ssec/llteacher/issues/273) | concurrent duplicate sends still make two model calls | Self-tagged **Blocking** in the issue's own body but not in Cordero's synthesized 11-item list (verified — the only one of the 39 with that discrepancy). `chatHandler` still discards `appendMessage`'s return value, so two concurrent identical sends both reach `streamText` even though the DB write itself is race-safe as of #266. Fix alongside #266's `resolveConflict`. |
| [#283](https://github.com/uw-ssec/llteacher/issues/283) | section messages still order by `createdAt`, not `seq` | Direct continuation of #269: `getSectionConversationMessages` (`sectionConversations.ts`) was untouched by that fix and still sorts the old way. ARCHITECTURE.md's "Message Ordering" section (written for #269) currently overclaims `seq` is authoritative on every read path — fix with #301. |
| [#304](https://github.com/uw-ssec/llteacher/issues/304) | `memberships[0]` is non-deterministic and assumes one course | Direct continuation: `chat.ts:375`'s `fallbackCourseId`, written this session for the #259/kind:"section" fix, has no `ORDER BY` — a multi-course user can silently land in the wrong course's scope. |
| [#307](https://github.com/uw-ssec/llteacher/issues/307) | align content gate with what replay and renderer can show | Minor; tightens `hasRenderableContent` further, the exact function #268 modified this session. |
| [#308](https://github.com/uw-ssec/llteacher/issues/308) | add size bounds and reject unknown `kind` instead of coercing | Minor; extends `historyMessageSchema`/the `kind` derivation, both touched this session for #264/#259. |
| [#301](https://github.com/uw-ssec/llteacher/issues/301) | ARCHITECTURE.md claims no route calls now-wired functions | Trivial doc fix — do together with #283, since fixing #283 changes what this section should say anyway. |
| [#306](https://github.com/uw-ssec/llteacher/issues/306) | lockfile, react peer range, locale, and lint hygiene | Trivial, zero-risk, four 1–6 line fixes bundled by the reviewer. |
| [#267](https://github.com/uw-ssec/llteacher/issues/267) | validate UUID params on new conversation routes | Moved here from the original PR 2 placement -- no real dependency on #25/#26/#143, it's a small, independent fix to PR 1's own `routes/conversations.ts`, the same shape as #308 above. |

**Not pulled forward, flagged for reconsideration:** [#286](https://github.com/uw-ssec/llteacher/issues/286) (chat errors render the raw HTTP response body to students — a real usability/security issue in the shipped #144 error row), [#287](https://github.com/uw-ssec/llteacher/issues/287) (#231's auto-titling landed on a path no client can reach — the feature is non-functional in production today), [#291](https://github.com/uw-ssec/llteacher/issues/291) (rename errors persist forever, shipped #6), [#292](https://github.com/uw-ssec/llteacher/issues/292) (rail message count off by half, shipped #216), and [#294](https://github.com/uw-ssec/llteacher/issues/294) (breadcrumb/nav hardcoded — the issue's own text says this PR is what made them wrong). All five are real bugs in features *this* PR shipped, not pre-existing debt — they're parked in PR 4's table below by default, but there's a real argument for pulling them into PR 1 instead. Worth a second look before merging.

---

## PR 2 — Section-Aware Prompting, LLM Config Resolution, Conversation Lifecycle

**Delivers:** the chat is no longer hardcoded (prompt or model); sections have a real start/restart lifecycle; the submission-uniqueness design gap is closed; M3's submission flow and dashboard get verified against real data for the first time.

| Issue | Title | Key requirements |
|---|---|---|
| [#25](https://github.com/uw-ssec/llteacher/issues/25) | section-context prompt assembly | pure `prompt.ts` builder module (config `base_prompt` + homework/section title+content + history → system prompt); tutor guardrail preserved verbatim; history replay parity (user/assistant roles, code fenced) once #3 lands; route template lookup through one resolver function; **Vitest snapshot proving solutions never enter the student prompt** |
| [#26](https://github.com/uw-ssec/llteacher/issues/26) | per-homework LLM config resolution | resolution order: homework `llm_config_id` → org default (`is_default && is_active`); provider client built per-request (model id, base URL, temperature, max tokens); API keys resolved from `organization_credentials` secret refs (never plaintext); graceful failure with logged UUID on missing/invalid config |
| [#178](https://github.com/uw-ssec/llteacher/issues/178) | LLMoxie API key + LiteLLM wiring | **Added to M4 milestone 2026-08-10, folded into PR 2 alongside #26 (same provider-client code path).** Add a LiteLLM-compatible provider client factory beside `getOpenRouter` in `apps/web/src/lib/ai.ts`; extend the `llm_provider` pg enum (`apps/web/src/db/schema/content.ts:28`, currently `openai`/`anthropic`/`claude_for_education`/`openrouter`/`local`) with the new provider value and a migration; read the LLMoxie API key the same way `OPENROUTER_API_KEY` is read today (`c.env.LLMOXIE_API_KEY` in `chat.ts`, sourced from `apps/web/.dev.vars` locally / `wrangler secret put` in prod — see the existing `OPENROUTER_API_KEY is not set` error message in `chat.ts:228` for the pattern to match); wire the new provider case into #26's per-request client-resolution switch so an `llm_configs` row with the new provider actually dispatches to it. **Sequence directly after #26** (not parallel) — it extends the same enum/dispatch code #26 introduces, so building both at once risks a merge conflict inside one function. |
| [#27](https://github.com/uw-ssec/llteacher/issues/27) | conversation lifecycle | `POST /api/sections/:id/conversations` creates conversation + canonical greeting message (via prompt builder); delete-and-restart soft-deletes current + creates fresh conversation for same section in one action; `type` column distinguishes student vs. instructor-test conversations; access matrix (owner/instructor read, owner-only write); **last requirement: once this ships, verify #22 and #23 end-to-end against real data and close them** |
| [#143](https://github.com/uw-ssec/llteacher/issues/143) | harden `/api/chat` | rate limit per user; request-size cap (`chat.ts:86`); tenancy binding — require conversation/section id, guard via `courseScopeFromAuthContext`, resolve model from #26 instead of hardcoded fallback (`chat.ts:96`); server-held system prompt (client can't override via crafted history — academic-integrity bypass fix); history windowing; `AbortSignal.timeout`; 400 vs 503 split; map provider 429 → retryable client error |
| [#128](https://github.com/uw-ssec/llteacher/issues/128) *(M3)* | resolve submission uniqueness/resubmission semantics | **design decision, resolve before/alongside #27's delete-and-restart implementation.** Answer: does delete-and-restart on an already-submitted section (a) supersede the existing submission (re-point at new conversation) or (b) implicitly un-submit? Then add the DB-level constraint that actually enforces the chosen answer (current schema doesn't survive soft-delete-and-recreate). Feed the answer directly into #27's delete-and-restart requirement above. |
| [#22](https://github.com/uw-ssec/llteacher/issues/22) *(M3)* | section submission flow | already merged (PR #154) — **re-run its Vitest suite + manual walk now that #27 produces real conversations**; confirm resubmit-in-place still behaves per #128's resolved semantics; close the issue |
| [#23](https://github.com/uw-ssec/llteacher/issues/23) *(M3)* | submissions dashboard | already merged except one box — **verify the real-data aggregation now that #27 exists**; leave the "drill-in navigation to transcript viewer" checkbox open (blocked on #29, PR 3) |
| [#274](https://github.com/uw-ssec/llteacher/issues/274) | model-call timeout + client stop control | #143 already requires `AbortSignal.timeout` -- this is that requirement's own filed issue; implement together (may close as a side effect of #143 itself) |
| [#279](https://github.com/uw-ssec/llteacher/issues/279) | collapse 8 sequential DB round-trips per turn | `chatHandler` gets rewritten for #25/#26/#143 anyway -- do the round-trip consolidation in the same pass, not a second one |
| [#282](https://github.com/uw-ssec/llteacher/issues/282) | per-course/global LLM budget, not just per-user | directly extends #26's LLM config resolution -- the scarce resource is one deployment-wide credential, so per-user-only limiting is the wrong axis once #26 makes config resolution real |
| [#305](https://github.com/uw-ssec/llteacher/issues/305) | move the section greeting out of the repository layer | the greeting is prompt-construction content (persona/wording), not persistence logic -- #25's prompt builder is its correct home once it exists |
| [#312](https://github.com/uw-ssec/llteacher/issues/312) | dedupe scope check, split `chatHandler`, fix stale comments | `chatHandler` is already getting heavily rewritten for #25/#26/#143/#274/#279 -- do the structural cleanup in that same pass |

**Primary files:** `apps/web/src/lib/prompts.ts` (new), `apps/web/src/lib/llm-config.ts` (new), `apps/web/src/lib/ai.ts` (extend with the LiteLLM/LLMoxie client factory, #178), `apps/web/src/db/schema/content.ts` (extend `llm_provider` enum + migration, #178), `apps/web/src/db/schema/conversations.ts` (new — split out of `content.ts`/`runtime.ts` per #27), `apps/web/src/lib/conversations.ts` (new service layer), `apps/web/src/server/routes/conversations.ts` (extend from PR 1), `apps/web/src/server/routes/chat.ts`, `apps/web/src/db/schema/runtime.ts` (submission/conversation constraint per #128's decision).

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
| [#275](https://github.com/uw-ssec/llteacher/issues/275) | observability on the chat failure path | moved here from the original PR 2 placement -- this PR is literally titled "Reliability, Safety & Research Instrumentation," a better thematic home than "pairs with #143." Log locally per the "Known soft dependencies" #45 pattern below, rewire when M8 ships. |
| [#277](https://github.com/uw-ssec/llteacher/issues/277) | memoize message lists, throttle streamed re-renders | perf/reliability, pairs with #96's streaming resilience work |
| [#278](https://github.com/uw-ssec/llteacher/issues/278) | scroll effect fires per token, ignores reduced-motion | same UI-perf/a11y bucket as #277 -- do together |
| [#288](https://github.com/uw-ssec/llteacher/issues/288) | disclose the 40-message context window to the student | directly #88's territory (context-window management) -- the student-facing half of that issue |
| [#289](https://github.com/uw-ssec/llteacher/issues/289) | delete affordance for tutor conversations | feature completion for #5 (DELETE route already exists server-side, no client affordance) |
| [#290](https://github.com/uw-ssec/llteacher/issues/290) | selecting a conversation gives no feedback until it loads | UI polish, pairs with #293 |
| [#293](https://github.com/uw-ssec/llteacher/issues/293) | empty-state flashes on load; disabled reason is invisible | UI polish, pairs with #290 |
| [#302](https://github.com/uw-ssec/llteacher/issues/302) | extract a shared hook for the two chat surfaces in App.tsx | refactor/cleanup once App.tsx's shape has settled post-PR2/PR3 |
| [#303](https://github.com/uw-ssec/llteacher/issues/303) | consolidate ten copies of the mount-fetch router in App.test.tsx | test hygiene |
| [#309](https://github.com/uw-ssec/llteacher/issues/309) | cover the production atomicity path and count-shaped properties | test hygiene, pairs with PR 4's own regression-suite pass |
| [#310](https://github.com/uw-ssec/llteacher/issues/310) | tutor rail interaction and rendering polish | polish |
| [#311](https://github.com/uw-ssec/llteacher/issues/311) | drop unused option surface; document capacity assumptions | chore |
| [#313](https://github.com/uw-ssec/llteacher/issues/313) | reap `chat_rate_limit_windows` rows -- unbounded growth, no cleanup | **added 2026-08-14 sync** -- tagged M4 but was in no PR's table. Its own issue text names this PR's not-yet-built `apps/web/src/server/jobs/` scheduled-job infra as its natural home (a `reap-rate-limit-windows.ts` job following the same pattern as `cleanup-stale-streams.ts`/`auto-submit-overdue.ts`) -- same thematic bucket as #275 above. |
| [#286](https://github.com/uw-ssec/llteacher/issues/286) | chat errors render the raw HTTP response body to students | **flagged for PR 1 reconsideration** (see PR 1 addendum) -- parked here only by default |
| [#287](https://github.com/uw-ssec/llteacher/issues/287) | #231's auto-titling landed on a path no client can reach | **flagged for PR 1 reconsideration** -- the feature is non-functional in production today |
| [#291](https://github.com/uw-ssec/llteacher/issues/291) | rename errors persist forever and crush the input | **flagged for PR 1 reconsideration** -- bug in shipped #6 |
| [#292](https://github.com/uw-ssec/llteacher/issues/292) | rail message count is off by half, credited to wrong row | **flagged for PR 1 reconsideration** -- bug in shipped #216 |
| [#294](https://github.com/uw-ssec/llteacher/issues/294) | breadcrumb and nav hardcode section, homework, and user | **flagged for PR 1 reconsideration** -- the issue's own text says this PR is what made them wrong |

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
