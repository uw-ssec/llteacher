---
type: Architecture
title: Tutor-behavior eval harness (evals/)
description: "evals/ scores answer leakage and Socratic over-help on 24 curated adversarial probes using the real prompts.ts/ai.ts; vitest fixture tests run in npm test, while npm run tutor:eval (recorded or live) is manual only."
tags: [architecture, evals, llm, testing]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:36Z" }
status: stable
governance: context
code_refs: [evals/tutor-behavior.ts, evals/scoring/answer-leakage.ts, evals/scoring/socratic-rubric.ts, evals/datasets/tutor-behavior-probes.json, evals/fixtures/recorded-responses.json, evals/results/baseline.json, evals/datasets/pii-scan.test.ts, evals/tsconfig.json, evals/README.md]
sources:
  - resource: evals/README.md
  - resource: evals/tsconfig.json
  - resource: turbo.json
  - resource: 9743dd7
---

**Purpose (#89).** The tutoring promise ("guide without giving away the answer") lives as prose in `apps/web/src/lib/prompts.ts` (`TUTOR_GUARDRAIL`, `DEFAULT_SYSTEM_PROMPT`, `VOICE_CONSTRAINTS`). `prompts.test.ts` proves structurally that solutions cannot reach the prompt; this harness checks behaviorally that a real model does not leak anyway.

**How it is wired.** `llteacher-evals` imports `apps/web/src/lib/{prompts,ai}.ts` by relative path (no package dependency). `evals/tsconfig.json` project-references `apps/web/tsconfig.worker.json` so those files typecheck under apps/web's own settings. That shared output directory is why turbo.json forces `llteacher-evals#typecheck` to wait for `llteacher-web#typecheck` (facts/code-turbo-evals-typecheck-race).

**Dataset:** `datasets/tutor-behavior-probes.json`, 24 hand-curated probes over six categories (solution_extraction, roleplay_jailbreak, authority_appeal, prompt_injection, hint_request, normal_help_seeking). Each has `sectionContent`, a `solution` (never sent to the model, used only for scoring), optional `finalAnswers`, and `studentMessage`. `pii-scan.test.ts` fails if any probe (or a local gitignored `flagged-feedback-export.json`) contains PII-shaped text.

**Scoring:** `scoreAnswerLeakage` -> leak/pass/uncertain (uncertain escalates to an LLM judge only in live mode; judge parse failure fails closed as leak). `scoreSocratic` -> scaffolds/over-helps/uncertain, scored separately so "solves it for you without quoting the answer" is not hidden.

**Modes:** `npm run tutor:eval` defaults to `--mode=recorded` (reads `fixtures/recorded-responses.json`, no network). `--mode=live` needs `OPENROUTER_API_KEY`, or `LLMOXIE_API_KEY` with `TUTOR_EVAL_PROVIDER=llmoxie`. Output: per-probe lines, `results/latest.json` (gitignored), and a diff against `results/baseline.json`. The committed baseline is from a recorded run (meanOverall 0.777). A mode mismatch between run and baseline prints the delta but skips the gate. A drop of more than 0.1 in mean overall exits non-zero.

Run it on prompt-template or model changes, not every PR. It has no CI job.

# Related Concepts
- [Stakeholder requirement: help instructors see where students have knowledge gaps](../requirements/stakeholder-knowledge-gap-insight.md): Insight into student gaps is a stated need the evals do not cover yet
