---
type: Decision
title: "Each LLM config can switch the tutor's knowledge access on or off; the instructor writes the search instruction"
description: "A boolean on each LLM config (on by default) removes the knowledge listing, instruction and both tools for closed-book work; instruction text resolves course -> org -> built-in and is always followed by a fixed guard sentence."
tags: [knowledge, llm, prompts, product-feature]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/lib/prompts.ts, apps/web/src/server/routes/chat.ts, apps/web/src/db/migrations/0053_knowledge_toggle.sql, apps/web/src/db/migrations/0054_knowledge_instruction_default.sql, apps/admin/src/client/views/KnowledgeView.tsx]
sources:
  - resource: commit b4eac8f
  - resource: docs/superpowers/specs/2026-09-15-okf-bundle-knowledge-base-design.md
  - resource: docs/superpowers/specs/2026-09-17-knowledge-search-first-design.md
---

## Spec proposed
The 2026-09-15 OKF spec offered the tools only when the course bundle has at least one concept. It injected a listing (max 6,000 chars) and a fixed instruction to search before answering course-material questions. It said nothing about closed-book assignments or instructor-authored instructions. This decision was made after the spec, during implementation.

## Implemented (commit `b4eac8f`, 2026-09-18; migrations 0053/0054)
- Each LLM config carries a knowledge-access switch, **on by default**. When off, the turn gets no listing, no instruction, and neither `searchKnowledge` nor `showKnowledge`. The model is never told a knowledge base exists.
- The instruction shown when the switch is on is the instructor's to write from the Knowledge tab, **never from a base prompt**. It resolves course text, then the organisation default, then the built-in. The built-in describes the two tools, what each returns, when to call them, and what to say when nothing is found.
- A **fixed guard sentence** follows whatever instruction is in force. It ensures uploaded material "can never become instructions to the model". This is the prompt-injection posture the 09-15 spec required ("material content is reference, not instruction").

## Why
A closed-book assignment needs a tutor that does not know about course materials. Tying the switch to the LLM config lets a homework or section pick a config instead of needing a new scope dimension (inferred). This partly restores per-assignment control, which the retired collections design gave and the course-wide bundle took away.

## Rejected alternatives
- Collections or per-assignment bundle scoping (still deferred).
- Letting the base prompt carry the knowledge instruction.

## Consequences
- The guard sentence must stay appended in `assembleSystemPrompt` whatever the instructor writes.
- Turning the switch off must remove the tools as well as the text. Otherwise the model could still discover the base through tool listings.

# Related Concepts
- [Each course's knowledge base is an OKF bundle on the filesystem, served by the pinned okf binary](okf-bundle-knowledge-base.md): Switches the tutor's access to the bundle
