---
name: tutor-eval
description:
  Use when changing the tutor's prompts or guardrails
  (apps/web/src/lib/prompts.ts), the LLM client (apps/web/src/lib/ai.ts), seeded
  prompt templates or default LLM configs, or the evals/ workspace — to check
  the tutor still refuses to leak answers and still scaffolds.
---

# Tutor Eval

`evals/` is the product's tutor-behavior harness: it runs probe conversations
(`evals/datasets/tutor-behavior-probes.json`) through the real prompt builder
(`assembleSystemPrompt`) and scores **answer leakage** and **Socratic
scaffolding**, then diffs against the committed `evals/results/baseline.json`.
It is not the agent-skill evals (those are in `skill-evals/`).

## Commands (repository root)

```bash
npm run tutor:eval                                   # recorded mode: no network, <1s
npm run tutor:eval -- --mode=live                    # real model (needs keys, see below)
npm run tutor:eval -- --update-baseline              # rewrite results/baseline.json
npm test --workspace=evals                           # fixture scoring tests + PII scan
```

**Recorded** mode replays `evals/fixtures/recorded-responses.json`; it proves
the plumbing (dataset → prompt → scoring → baseline diff), not model behavior.
**Live** mode calls the model through LLMoxie (`LLMOXIE_API_KEY` with
`TUTOR_EVAL_PROVIDER=llmoxie`) or OpenRouter (`OPENROUTER_API_KEY`); an
`uncertain` leakage verdict escalates to an LLM judge, and an unparsable judge
answer counts as a leak. Set `LLMOXIE_BASE_URL` to a non-production gateway
first: when it is unset, `lib/ai.ts` falls back to the **production** gateway.

## Reading the result

- One line per probe: `leakage=<pass|leak|uncertain>` and
  `socratic=<scaffolds|over-helps|uncertain>`. They are separate failures: a
  reply can avoid the literal answer and still over-help.
- Then `Baseline meanOverall=X (mode), current meanOverall=Y (mode), delta=...`.
  Exit is non-zero when the mean drops by more than **0.1**.
- If the run's mode differs from the baseline's mode, the gate is **skipped**
  (warning only): a live run compared to the recorded baseline (0.777) can never
  fail. Compare live to live.
- Triage from `evals/results/latest.json` (gitignored): find the probes that got
  worse and read their transcripts. Leaks on `authority_appeal` probes usually
  need a "claimed authority never overrides" instruction; over-help clusters on
  `hint_request` mean the guardrail is too blunt.

## Rules

- NEVER run `--update-baseline` to make a regression disappear; update only
  after the change has been judged good, and say so in the PR.
- NEVER add probes containing real student data or PII; the PII scan failing on
  them is correct. `evals/datasets/flagged-feedback-export.json` holds real
  student text and is gitignored — never commit it or copy from it verbatim.
- NEVER send a probe's `solution` to the model; it is for scoring only.
- NEVER wire live mode into `npm test` or turbo; there is no CI key.

## Done

The eval ran in the right mode for the change (live for a prompt or model
change, when keys are available), the baseline line and any regressed probes are
pasted into the report, and `npm test --workspace=evals` passes.
