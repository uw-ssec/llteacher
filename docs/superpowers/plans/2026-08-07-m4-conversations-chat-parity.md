# M4: Conversations, Chat & R Execution Parity — PR Sequencing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan issue-by-issue (one fresh subagent per GitHub issue, task review after each, whole-branch review per PR). Scope: GitHub milestone 4 (21 issues as of the 2026-08-11 sync — see below) + the M3 issues that are blocked on M4 work. Broken into 4 sequential, independently-mergeable PRs. Ends with a full epic acceptance pass against issue #30's own checklist.

## 2026-09-01 sync check (PR4 merged; PR5 kickoff)

**Start here if you're picking up PR 5.** PR 4 ([#413](https://github.com/uw-ssec/llteacher/pull/413)) merged into `staging` today. New worktree `m4-conv-chat-pr5` created from `staging` (not from `origin/llteacher01` — see the 08-07 "Context" section's own warning about the default branch being stale).

Full audit of PR 5's table against live GitHub + code before dispatching:

- **#277, #278, #289, #290, #293 are already CLOSED**, via out-of-band PRs [#380](https://github.com/uw-ssec/llteacher/pull/380), [#384](https://github.com/uw-ssec/llteacher/pull/384), [#381](https://github.com/uw-ssec/llteacher/pull/381) merged 2026-08-27 — none of these went through this plan's dispatch process, they were done directly. Nothing further needed.
- **#295, #296, #297, #298, #300 are code-complete on `staging` but were never closed.** Commit `02f7aad` (PR #385, "rail polish", merged 2026-08-27) silently folds in all five accessibility fixes — confirmed via `git log -S` for each issue's signature change (`onActivateValue`, `pencilRef`, the `role="log"` container, `aria-busy`, the corrected `#95958D` dark-contrast token) — even though PR #385's own title/body never mentions #295-300. This is the same "PR body never used `Closes #N`" pattern flagged in the 2026-08-19 entry below; it keeps recurring. **Closed all five 2026-09-01**, referencing PR #385. #300 keeps one requirement unchecked (real screen-reader verification) — explicitly a human-only step per the issue's own text, not something this pass can satisfy.
- **#291, #292, #294, #286 have a real, tested fix that was never merged or even PR'd**: commit `d1f58b1` on remote branch `fix/m4-student-facing-defects` (dated 2026-08-27), 565-line diff, includes its own test coverage — but no PR was ever opened, and the branch sat 7 commits behind `staging` by the time this sync ran. Merging it directly conflicts in 7 files (later PRs #380/#381/#384/#385/#386 touched the same UI surface). **Ported forward via a fresh implementer dispatch** rather than force-resolving the merge — see this plan's SDD ledger (`.superpowers/sdd/2026-08-07-m4-conversations-chat-parity/progress.md`) for the reference patch and the reasoning. **Lesson for future passes: check `git branch -a --contains` / unmerged remote branches before assuming an issue's fix doesn't exist yet** — this is the second time in this epic a real fix sat unmerged with no PR (the first being the 9 issues closed in the 08-25 sync).
- **#89 is now unblocked** — PR4 shipped #88 (context-window management) today.
- **New issues #414-#431** (18 of them) were filed today as fallout from PR4's own review/merge and are tagged M4's milestone, but are **not in this plan doc at all** and were **not folded into this PR5 pass** — they're a different code area (jobs/auto-submit, LLM failover, grading tier, admin) than PR5's client-UX/a11y/eval scope, and the plan doc is the thing that was asked for by name. Needs its own triage pass (PR 6?) before this epic can be called fully closed against #30's own checklist — flagging here so the gap is visible, not silently absorbed into "PR5 done."



**Start here if you're picking up PR 4 or PR 5.** PR 3 ([#366](https://github.com/uw-ssec/llteacher/pull/366)) is open (`CHANGES_REQUESTED`, not yet merged) and already covers #28, #246, #29, #80, #168, plus #23 (M3) and #368–373 — its own table below is otherwise still accurate. **Do not start PR 4 work until PR 3 merges and its "Closes" list is confirmed to have actually closed everything it claims** — PR 317 (PR 2) hit a real gap here: GitHub's closing-keyword parser only recognizes the *first* issue after a `Closes`/`Fixes` keyword, not a full comma-separated list, so 28 of PR 317's 30 claimed closes silently stayed open until manually closed on 2026-08-25. **When writing PR 4/PR 5's bodies, use one `Closes #N` per line (PR 212's style), never a comma list (PR 317's style)** — or budget a manual close-and-milestone pass after merge like the one just done.

A full audit of all 79 originally-scoped M4 issues plus everything filed since found:

- **9 issues were already code-complete but never closed or milestoned**, because no PR's "Closes" line ever referenced them (some predate PR 1's merge, some are Cordero round-3/round-4 audit issues whose fixes landed as part of a differently-numbered issue's commit). Verified against the current code on `worktree-m4-conv-chat-pr3` (staging + PR 3, the most current branch) before making this claim — this doc has been burned before by asserting completion from a stale note (see the 2026-08-14 entry's own #261/#262/etc. claim, which itself was never actioned):
  - **#261, #262, #265, #271, #272, #276, #284** — confirmed via grep (message ordering by `seq`, atomic `reserveRateLimitSlot` INSERT...ON CONFLICT, `latestSectionConversationRef`/`pendingGreetingConversationIdRef` staleness fixes, `deploy` script running `db:migrate` first).
  - **#269** — the *canonical* fix for the seq-backfill bug; its own last comment says outright "Duplicate note: #260 covers the same underlying defect... this is the one with the actual fix," and #260 (the duplicate) was already closed. #269 itself was simply never closed.
  - **#299** — confirmed via grep (`<main id="conversation-main">`, skip-link anchor present in `App.tsx`).
  - Double-checked each fix's actual origin with `git show 7d49636 -- <file>` (PR #212's squash commit) before closing, since the initial grep ran against the PR3 worktree (staging + PR3 combined) and could have misattributed a PR3 addition — all 9 confirmed present in PR #212 itself, none touched by PR #366 (PR3). **All 9 closed 2026-08-25**, referencing PR #212.
- **#296, #297, #298 (contrast, pencil hit-target, rename-exit focus) could not be confirmed done** from a code grep alone — some adjacent focus/contrast CSS exists but nothing that unambiguously satisfies these three issues' specific acceptance criteria. Left in PR 5's table below as real work, flagged "verify current state first" rather than assumed-done or assumed-not-done.
- **#305 and #312** are genuinely partially done (PR 317 marked both "Progresses," not "Closes," on purpose) — #305's remaining requirement (generate the tool-usage prompt paragraph from `TOOLS` instead of hand-writing it) was explicitly deferred until a second/third tool existed; **PR 3 just shipped `executeRCode` and `markSectionComplete`, so #305 is now unblocked** and should be finished, not re-scoped. #312's remaining "31-place stale-comment sweep" is likely much smaller now than when filed (per its own PR 2 disposition note, most of it was already resolved as a side effect of #268 landing) — re-diff against the current comment set rather than assuming the original 31 still stand.
- **#167 (M3, auto-submit overdue sections)** was explicitly blocked on #128's uniqueness-semantics decision — **#128 has been resolved and shipped since (PR #247, merged 2026-08-12)** — #167 is unblocked and belongs in PR 4 per the original plan's M3-coupling note.
- **#259** ("`/api/chat` bypasses every section-conversation invariant, reinstating #237") references an unmilestoned issue, [#237](https://github.com/uw-ssec/llteacher/issues/237) ("TA section conversations are recorded as student work"). #237 itself is out of M4's scope (no milestone, predates this epic) but #259 is real M4 work — read #237 for context before implementing #259, don't expand scope to fix #237 itself unless #259's own body requires it.
- **Everything else genuinely open and unstarted** (~39 issues, few filed as far back as PR 1's round-3 audit and never triaged into any PR table) is split below into **PR 4** (server-side correctness, security, reliability, data integrity — ships first, higher-risk defects) and **PR 5** (client UX polish, accessibility, eval/feedback instrumentation, test/refactor hygiene — ships second, lower individual risk, larger count). This replaces the single PR 4 table below, which predates most of these issues even existing.

---

## 2026-08-19 sync check (PR2 merged; PR3 kickoff — #246 folded in)

**PR 2 (#317) merged into `staging` at 2026-08-19T20:03:58Z.** Confirmed live: all four of PR 3's issues (#28, #29, #80, #168) are OPEN and unassigned — PR 3 has not started.

Full M4-milestone audit against every PR table in this doc turned up one real gap and one already-resolved issue that was never closed:

- **[#246](https://github.com/uw-ssec/llteacher/issues/246)** (TA transcript-read access — was untagged, now added to M4) — its own body says *"#29 (instructor transcript viewer) will have to resolve it"* and its requirements say *"Fold the decision into #29's acceptance criteria either way."* Section-conversation reads are gated `isInstructorOf` (instructor/admin), while the submissions dashboard that will link into #29's viewer is gated `requireGraderOf` (instructor/admin/**TA**) — a TA can see a submission in the matrix and then 403 opening its transcript. **Added to PR 3's table below**, sequenced alongside #29 since #29's own access-control design can't be finalized without this decision.
- **#263** (dropped course members retain conversation/LLM access, Major security) — verified against current `staging`: `getOwnedConversationOrNull` (`apps/web/src/server/repositories/conversations.ts`) already takes an `isMemberOfCourse` predicate and 404s a caller with no live membership, landed as a side effect of PR2's conversation-resolution rewrite. Closed on GitHub, no PR3 action needed.
- **#364** (rewire `streamWithFallback` onto #317's resolution) — new issue, filed 20 min after PR2 merged; a real capability gap (provider failover orphaned by PR2's rewrite) but different code area than PR3 (LLM provider dispatch, not WebR/transcripts). Flagged on the issue for its own triage slot (PR4 or standalone) — not scheduled here.
- Broader housekeeping noted but not actioned this pass: several PR1/PR2 issues (#26, #27, #143, #178, #248, #274, #279, #305, #312, #318, #333, the PR1-addendum set) are already implemented and merged but still show OPEN on GitHub — PR2's PR body never used `Closes #N` syntax. Worth a dedicated cleanup pass, out of scope for PR3 kickoff.

## 2026-08-19 sync check (#340/#343 supersede this plan's own default-model claim)

The 2026-08-15 entry below (Blocking #1/#2) named `openrouter`/
`google/gemma-4-31b-it:free` as the new default -- accurate when written,
but superseded the same PR by #340/#343 (migration 0035,
`apps/web/scripts/seed.ts:245-246`): every organization's default
`llm_configs` row is `llmoxie`/`gpt-5.3-codex` now, and `LLMOXIE_API_KEY`
(not `OPENROUTER_API_KEY`) is the binding a real deploy needs set for
chat to work at all -- see #343's own commit and `apps/web/README.md`'s
"Deploying" section. Flagged here (#317 review, #353) so an operator
reading only the entry below doesn't provision the wrong secret.

## 2026-08-15 sync check (PR2 review-response pass)

Cordero's review on [PR #317](https://github.com/uw-ssec/llteacher/pull/317) requested changes on 5 items and filed 7 follow-up issues (#321–#327) from an 11-axis audit, explicitly marked not blocking. Per Kshitij's decision, this pass fixes **all of it inline on `m4-conv-chat-pr2`** — the 5 blocking items, the 3 "strongly recommend" items, and 6 of the 7 deferred issues (#327's code-level fixes land; its manual-AT-verification requirement needs a human with a real screen reader, tracked as a residual).

**Design decisions made this pass** (each was a genuine fork Cordero left open, not prescribed):

- **#325 (course-scoped LLM config + write paths)** — built now, in this same branch, not deferred to a separate PR, despite being additive/feature-shaped rather than a regression fix.
- **#322 (concurrent-turn ordering)** — implemented as a per-conversation turn lock (conditional update on the conversation row; a second concurrent turn gets a distinct retryable 409), not the alternative clientMessageId-keyed-replay approach.
- **#324 (prompt_templates scope columns)** — implemented all 4 scope levels (org/course/homework/section) to match what the schema already documents, rather than dropping the unused `scope_section_id`/`scope_homework_id` columns.
- **Blocking #1/#2 (llm_configs data migration)** — checked the real shared dev Neon DB directly rather than guessing: 118 of 166 orgs (mostly `.db.test.ts` debris, but the fix has to be correct regardless) have no `is_default=true` row; 0 rows currently have `provider='anthropic'` (item #2's specific failure mode isn't live here, but the fix is defensive/idempotent so it's harmless to apply). New default rows use `openrouter`/`google/gemma-4-31b-it:free`, matching `scripts/seed.ts`.
- **Release gate (blocking #4)** — Cordero scoped his fix to `getSectionPromptContext` only, noting `startSectionConversation` "predates this PR." Fixed **both** paths: the greeting itself is built from `section.content`, so gating only the chat-turn query would still leak an unreleased section's content the moment a conversation starts.
- **#321 (LLM call observability)** — full cost/token capture (`input_tokens`/`output_tokens`/`cost_cents`) implemented, not just outcome/error logging, per explicit decision (the issue itself left this open: "decide and document whether cost/token capture is required for the CDI reporting story").
- **#326's rate-limit-window purge** — done as a lightweight inline best-effort purge (mirroring `webhookEvents.ts`'s existing purge-query precedent) rather than building PR4's not-yet-built `apps/web/src/server/jobs/` scheduled-job infra just for this. **This supersedes issue #313 and PR4's table entry below** — #313 is resolved by this pass, not still pending PR4.

See the PR review thread and `gh issue view 321..327` for full technical detail on each item; not duplicated here.

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
| [#246](https://github.com/uw-ssec/llteacher/issues/246) | TA transcript-read access decision | decide whether reading a student's section transcript is grader-tier (`requireGraderOf`: instructor/admin/TA, matching the submissions-dashboard tier that links into #29) or author-tier (`isInstructorOf`: instructor/admin only, the current default); extend `canReadSectionConversation` (`apps/web/src/server/repositories/sectionConversations.ts`) with a grader predicate if grader-tier is chosen; pin the new matrix in `sectionConversations.access.test.ts`; fold the decision directly into #29's own access-control implementation rather than building #29 first and reconciling after |

**Primary files:** `apps/web/src/client/hooks/useWebR.ts` (new), `apps/web/src/client/hooks/useRExecution.ts` (new), `packages/ui/src/generative/renderers/CodeExecution.tsx` (new), `apps/web/src/server/routes/instructor/transcripts.ts` (new), `apps/admin/src/client/views/TranscriptListView.tsx` / `TranscriptDetailView.tsx` (new), `apps/web/src/lib/instructor-authz.ts` (new — the org/course-scope helper referenced in the cross-cutting invariants above), `apps/web/src/server/routes/chat.ts` (executeRCode + markSectionComplete tools), `apps/web/src/server/repositories/sectionConversations.ts` (#246's `canReadSectionConversation`).

**Closes:** #23's remaining checkbox once #29's drill-in route exists — update `SubmissionsView.tsx` to link into `TranscriptDetailView`.

---

## PR 4 — Server-Side Reliability, Security & Data Integrity

**Delivers:** the remaining correctness/security defects on the hot chat path get fixed (prompt injection via history, duplicate model calls, silently-corrupted transcripts), pagination becomes real end-to-end, LLM config resolution actually reaches every call site, and M3's auto-submit (now unblocked by #128) ships. This is the higher-risk half of what's left — bugs a student or a malicious client can trigger today — so it ships before PR 5's UI polish.

**Note:** the 9 issues that were already done but unclosed (#261, #262, #265, #269, #271, #272, #276, #284, #299 — see 2026-08-25 sync check above) were closed as part of that sync, referencing PR #212. Nothing further needed for them.

| Issue | Title | Key requirements |
|---|---|---|
| [#264](https://github.com/uw-ssec/llteacher/issues/264) | client can inject a system message via unvalidated history | **Security.** Untrusted client-supplied history must be filtered/validated to reject a `role:"system"` entry before it reaches the model — same trust boundary #143 established for the rest of the payload. |
| [#266](https://github.com/uw-ssec/llteacher/issues/266) | reused `clientMessageId` drops the user message from transcript | Idempotency key collision currently discards a legitimate retry's message instead of the previously-served one; fix the conflict resolution in the `appendMessage`/idempotency path #213 introduced. |
| [#268](https://github.com/uw-ssec/llteacher/issues/268) | truncated answers persisted as complete and replayed forever | A connection drop mid-stream must not persist (or replay) a partial answer as if it were the finished turn — pairs directly with #96's streaming-resilience work below; consider doing both in one pass. |
| [#273](https://github.com/uw-ssec/llteacher/issues/273) | concurrent duplicate sends still make two model calls | `chatHandler` discards `appendMessage`'s return value; two concurrent identical sends both reach `streamText` even though the DB write is race-safe. Self-tagged Blocking in the issue's own body. |
| [#283](https://github.com/uw-ssec/llteacher/issues/283) | section messages still order by `createdAt`, not `seq` | Direct sibling of #261 (already fixed) but at the *section*-conversation read path (`getSectionConversationMessages` in `sectionConversations.ts`) rather than the tutor one — confirmed still on `createdAt` via grep, genuinely unfixed. |
| [#259](https://github.com/uw-ssec/llteacher/issues/259) | `/api/chat` bypasses every section-conversation invariant, reinstating #237 | Read #237 for context (TA section conversations misrecorded as student work) before implementing — #259 is the M4-scoped fix, #237 itself is out of scope. |
| [#304](https://github.com/uw-ssec/llteacher/issues/304) | `memberships[0]` is non-deterministic, assumes one course | `chat.ts`'s `fallbackCourseId` has no `ORDER BY`; a multi-course user can land in the wrong course's scope. |
| [#96](https://github.com/uw-ssec/llteacher/issues/96) | streaming resilience | interrupted stream persists partial + flags it (do together with #268 above); client shows "interrupted — continue?"; client idempotency key + server dedupe window; failed send stays in composer with retry; two-tabs-same-conversation = last-writer-wins, no realtime sync (recorded non-goal); fault-injecting mock transport test |
| [#275](https://github.com/uw-ssec/llteacher/issues/275) | observability on the chat failure path | Log locally per the "Known soft dependencies" #45 pattern below; rewire to #45's real logging surface when M8 ships. |
| [#279](https://github.com/uw-ssec/llteacher/issues/279) | collapse remaining sequential DB round-trips per turn | PR 2 already collapsed 3 of 4 (deliberately left the rate-limit-check/conversation-resolution pair sequential — see PR 2's own note on why `Promise.all` there is unsafe). Re-check what's left against the current `chatHandler` before assuming the original count still applies. |
| [#305](https://github.com/uw-ssec/llteacher/issues/305) | move section greeting out of the repository layer | **Now unblocked** — PR 3 shipped the 2nd/3rd tools (`executeRCode`, `markSectionComplete`) this was waiting on. Finish requirement 3: generate the tool-usage paragraph from `TOOLS` instead of hand-writing it in `DEFAULT_SYSTEM_PROMPT`. |
| [#312](https://github.com/uw-ssec/llteacher/issues/312) | dedupe scope check, split `chatHandler`, fix stale comments | Re-diff the "31-place stale comment" claim against current code first — PR 2's own note says most were already fixed as a side effect of #268 landing; likely a much smaller remaining set. |
| [#364](https://github.com/uw-ssec/llteacher/issues/364) | rewire `streamWithFallback` onto #317's config/provider resolution | `streamWithFallback` predates #26/#178's real config resolution; make sure it actually calls through the resolved-per-conversation path, not a stale hardcoded one. |
| [#365](https://github.com/uw-ssec/llteacher/issues/365) | `testLlmConfigHandler` hardcodes OpenRouter provider/key | Test-only handler ignores the config's actual provider — fix alongside #364 since both touch the same resolution call site. |
| [#267](https://github.com/uw-ssec/llteacher/issues/267) | validate UUID params on conversation routes | Small, independent Zod-shape fix on `routes/conversations.ts`. |
| [#280](https://github.com/uw-ssec/llteacher/issues/280) | wire conversation and message pagination in the client | Server already paginates (#224, PR 1); client never sends `limit`/`before` or offers load-more. Do together with #281. |
| [#281](https://github.com/uw-ssec/llteacher/issues/281) | conversation list cursor drops rows; no tiebreaker or index | The `updatedAt` cursor #280 would page on isn't safe without a tiebreaker + supporting index — fix this first, #280 second. |
| [#285](https://github.com/uw-ssec/llteacher/issues/285) | document the five conversation routes for consumers | Three other CDI teams integrate against these with zero docs today — path/method/auth/request-response/error codes per route. |
| [#88](https://github.com/uw-ssec/llteacher/issues/88) | context-window management | token-budget the assembled prompt (system+section+history within model window + response headroom); recent-window + rolling summary strategy (simple truncation acceptable v1 fallback); code/`code_execution` messages get recency-aware treatment; per-model-aware window sizes; boundary + no-leakage-through-summary tests |
| [#288](https://github.com/uw-ssec/llteacher/issues/288) | disclose the 40-message context window to the student | Student-facing half of #88 — do in the same pass since both touch the same windowing logic. |
| [#167](https://github.com/uw-ssec/llteacher/issues/167) *(M3)* | auto-submit overdue sections | scheduled job submits past-due sections with an active-but-unsubmitted conversation; distinguishable `source` column (`student`\|`auto`); idempotent re-runs; observable run counts. **Unblocked**: #128's uniqueness semantics shipped in PR #247 (2026-08-12) — build against the real constraint, not a placeholder. |
| [#306](https://github.com/uw-ssec/llteacher/issues/306) | lockfile, react peer range, locale, and lint hygiene | Trivial, zero-risk, bundled chores — do first as a warm-up commit. |
| [#307](https://github.com/uw-ssec/llteacher/issues/307) | align content gate with what replay and renderer can show | Minor; tightens `hasRenderableContent`. |
| [#308](https://github.com/uw-ssec/llteacher/issues/308) | add size bounds, reject unknown `kind` instead of coercing | Minor; extends `historyMessageSchema`. |
| [#301](https://github.com/uw-ssec/llteacher/issues/301) | ARCHITECTURE.md claims no route calls now-wired functions | Do alongside #283 — fixing #283 changes what this doc section should say anyway. |

**Primary files:** `apps/web/src/server/routes/chat.ts`, `apps/web/src/server/repositories/sectionConversations.ts`, `apps/web/src/server/repositories/conversations.ts`, `apps/web/src/lib/ai.ts`, `apps/web/src/lib/prompts.ts`, `apps/web/src/lib/tokenCounter.ts` (new), `apps/web/src/server/routes/chat/resume.ts` (new), `apps/web/src/server/jobs/auto-submit-overdue.ts` (new), `apps/web/src/client/App.tsx` (pagination wiring), `docs/architecture/` (route docs, #285).

**Not pulled in — genuinely PR 5 territory:** everything client-UI/a11y/eval-shaped. See below.

---

## PR 5 — Client UX Polish, Accessibility, Eval Harness & Feedback Loop

**Delivers:** the tutor-rail/composer UI bugs get fixed, the outstanding accessibility set is closed out, the answer-leakage eval harness and student-feedback loop ship (research instrumentation), and remaining test/refactor hygiene lands. Lower individual risk than PR 4's items — mostly single-surface UI bugs — but larger in count, so it's its own PR rather than tacked onto PR 4.

| Issue | Title | Key requirements |
|---|---|---|
| [#270](https://github.com/uw-ssec/llteacher/issues/270) | composer loses focus on every send and never regains it | |
| [#277](https://github.com/uw-ssec/llteacher/issues/277) | memoize message lists, throttle streamed re-renders | perf, do together with #278 |
| [#278](https://github.com/uw-ssec/llteacher/issues/278) | scroll effect fires per token, ignores reduced-motion | same UI-perf/a11y bucket as #277 |
| [#286](https://github.com/uw-ssec/llteacher/issues/286) | chat errors render the raw HTTP response body to students | bug in shipped #144 |
| [#287](https://github.com/uw-ssec/llteacher/issues/287) | #231's auto-titling landed on a path no client can reach | feature is non-functional in production today |
| [#289](https://github.com/uw-ssec/llteacher/issues/289) | delete affordance for tutor conversations | DELETE route already exists server-side (#5); no client affordance |
| [#290](https://github.com/uw-ssec/llteacher/issues/290) | selecting a conversation gives no feedback until it loads | pairs with #293 |
| [#291](https://github.com/uw-ssec/llteacher/issues/291) | rename errors persist forever and crush the input | bug in shipped #6 |
| [#292](https://github.com/uw-ssec/llteacher/issues/292) | rail message count is off by half, credited to wrong row | bug in shipped #216 |
| [#293](https://github.com/uw-ssec/llteacher/issues/293) | empty-state flashes on load; disabled reason is invisible | pairs with #290 |
| [#294](https://github.com/uw-ssec/llteacher/issues/294) | breadcrumb and nav hardcode section, homework, and user | issue's own text says PR 1 is what made this wrong |
| [#310](https://github.com/uw-ssec/llteacher/issues/310) | tutor rail interaction and rendering polish | catch-all polish pass, do last in this bucket once the above land |
| [#295](https://github.com/uw-ssec/llteacher/issues/295) | rename pencil nested inside `role=button` not exposed to AT | |
| [#296](https://github.com/uw-ssec/llteacher/issues/296) | muted text and pencil icon fail WCAG contrast in the rail | **Verify current state first** — some adjacent contrast CSS already exists; confirm it doesn't already satisfy this before implementing. |
| [#297](https://github.com/uw-ssec/llteacher/issues/297) | rename pencil target is 12px, half the WCAG 2.5.8 minimum | **Verify current state first**, same caveat as #296. |
| [#298](https://github.com/uw-ssec/llteacher/issues/298) | exiting rename and error boundaries destroy keyboard focus | **Verify current state first**, same caveat as #296. |
| [#300](https://github.com/uw-ssec/llteacher/issues/300) | streaming assistant output is never announced to screen readers | |
| [#89](https://github.com/uw-ssec/llteacher/issues/89) | answer-leakage eval harness | checked-in eval set (adversarial + normal prompts); `npm run tutor:eval` runs real prompt builder + judge pass; baseline scores + regression-fail threshold; solution-leakage cases double as #25's structural unit fixtures; deterministic/recorded mode for CI. Depends on PR 4's #88 (context-window management) being in place first. |
| [#90](https://github.com/uw-ssec/llteacher/issues/90) | student feedback flag on AI responses | per-message flag affordance (reason + optional comment), one per message per student; instructor review surface; flagged examples exportable into #89's eval set — sequence #89 and #90 together, in either order, since they feed each other |
| [#302](https://github.com/uw-ssec/llteacher/issues/302) | extract a shared hook for the two chat surfaces in App.tsx | refactor once App.tsx's shape has settled post-PR3/PR4 |
| [#303](https://github.com/uw-ssec/llteacher/issues/303) | consolidate ten copies of the mount-fetch router in App.test.tsx | test hygiene |
| [#309](https://github.com/uw-ssec/llteacher/issues/309) | cover the production atomicity path and count-shaped properties | test hygiene |
| [#311](https://github.com/uw-ssec/llteacher/issues/311) | drop unused option surface; document capacity assumptions | chore |

**Primary files:** `apps/web/src/client/App.tsx`, `apps/web/src/client/views/TutorConversationsList.tsx`, `packages/ui/src/components/EditableTitle.tsx`, `packages/ui/styles.css`, `apps/web/src/db/schema/content.ts` (`responseFeedback` table, new), `evals/tutor-behavior.ts` + `evals/datasets/` + `evals/scoring/` (new), `apps/web/src/server/routes/feedback.ts` (new), `apps/admin/src/client/views/FeedbackDashboard.tsx` (new).

### Final step of PR 5: Epic acceptance test against #30's own criteria

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
- **PR 4 specifically:** the security/correctness fixes (#264, #266, #268, #273, #259) have no shared regression test today — add one exercising the actual attack/race shape described in each issue, not just a unit test of the fixed function in isolation.
- **PR 5 / final:** the full regression suite + manual acceptance checklist above, plus updating #30's own checkbox list in GitHub as each child issue closes.
