---
type: Decision
title: "Prompt templates resolve most-specific-wins, from section up to a built-in default"
description: "The tutor system prompt comes from prompt_templates resolved section -> homework -> course -> org -> built-in fallback, with the resolved template version pinned per conversation; the same override model was reused for knowledge settings."
tags: [llm, prompts, configuration]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/lib/prompts.ts, apps/web/src/server/repositories/promptTemplates.ts, apps/web/src/server/routes/promptTemplates.ts, apps/web/src/db/migrations/0037_prompt_templates_org_backfill.sql, evals/tutor-behavior.ts]
sources:
  - resource: docs/architecture/multi-tenant-data-model.md
  - resource: docs/superpowers/specs/2026-09-09-knowledge-management-design.md
  - resource: commit cc47407
  - resource: commit b4eac8f
---

## Spec proposed
Data-model §3.5 Q2 asked whether template inheritance should be a strict chain or composable. The recommendation was strict resolution plus a `compose_with_parent` flag. The Django baseline had only `LLMConfig.base_prompt` and no place for Sara's level-1 (behavior) and level-2 (problem-specific) prompts.

## Implemented
`apps/web/src/lib/prompts.ts`:
- `resolvePromptTemplate` walks section → homework → course → org → built-in fallback.
- The returned id and version identify the most specific match, and conversations pin that version. Later turns reuse the pinned id and resolve fresh only when it is missing.
- `assembleSystemPrompt` composes the base prompt, `TUTOR_GUARDRAIL`, section context, and the knowledge listing (capped at `KNOWLEDGE_LISTING_MAX_CHARS = 6000`). The most specific instruction for the current turn goes last.
- Template writes use `runAtomically` (`repositories/promptTemplates.ts`).
- Migration 0037 backfilled org-level templates.
- Section-aware prompting and LLM-config resolution landed in M4 PR2 (commit `cc47407`, #317).
- Whether a `compose_with_parent` flag exists was not checked in code.

## Why
One layering model across the instructor console. The 2026-09-09 knowledge spec cited this precedent when it rejected additive resolution for collections: "two different inheritance rules on two adjacent instructor-facing features is a support burden." The knowledge-instruction text (commit `b4eac8f`) resolves the same way: course text, else org default, else built-in.

## Rejected alternatives
- Additive or composed prompts by default.
- A single global `base_prompt`.

## Consequences
- Adding a section-level template silently overrides the course template. Instructors must restate anything they want kept.
- The eval harness (`evals/`) imports the real `prompts.ts`, so guardrail edits are measured on the same code path students use.

# Related Concepts
- [LLM tutor chat pipeline](../architecture/llm-tutor-pipeline.md): Prompt assembly in the tutor pipeline
- [Tutor-behavior eval harness (evals/)](../architecture/eval-harness.md): The eval exercises the real prompt builder
