---
type: Decision
title: Subject figures compute what they assert; the model supplies only arguments
description: "Generative-UI figures (ECON 201, clinical informatics and statistics packs, plus shared worked steps) draw from model arguments but compute every outcome, number and sentence in packages/ui/src/generative/lib; deny-by-default parsers render nothing on bad input; packs are opt-in per LLM config."
tags: [generative-ui, econ, clinical-informatics, statistics, dataviz, llm-config]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T21:05:00Z" }
status: stable
---

## Decision

Display tools render inline figures: shared showWorkedSteps and knowledgeCheck; the ECON 201 pack (showMacroModel, showGdpComposition, showMultiplier, showLaborForce, showInflation); the clinical informatics pack (showDiagnosticAccuracy, showPrevalenceEffect, showRocCurve, showPatientTimeline, showCdsRule); and the statistics pack (showDistribution). The model names WHAT to draw; the figure COMPUTES the consequences (equilibrium movement, GDP shares, the multiplier, labor rates, inflation; sensitivity/specificity/PPV/NPV/LRs, Bayes PPV by prevalence, trapezoid AUC and Youden's J, CDS rule evaluation with missing data; distribution tail probabilities). A model that asserts a wrong direction or number can't make the picture and its takeaway contradict each other. Only WorkedSteps presents the tutor's own arithmetic, and it states no computed takeaway for that reason. A bioinformatics pack was built and removed: the course is clinical informatics.

## Subject packs are opt-in per LLM config

packages/ui/src/generative/toolkits.ts lists the packs. The instructor ticks them under "Subject figures" on the LLM config form, and they're stored in llm_configs.genui_toolkits (text[], default '{}', migration 0056). This follows [the knowledge-access switch](knowledge-access-toggle-per-llm-config.md): homework → course → org resolution already picks a config per conversation. toolsForConversation withholds every tool of a pack the resolved config hasn't enabled, so the model is never offered it. Shared tools aren't in any pack and are always offered. Figures already in a transcript still render after a pack is turned off, because history is what happened. The route rejects an unknown pack id with a 400, and an update that omits the field keeps the stored packs.

## Invariants

- Each tool has a deny-by-default parser (toolInputs.ts, toolInputs.clinical.ts): wrong type OR wrong meaning (MPC outside (0,1), ROC points whose sensitivity falls, a CDS text value compared with <, mixed timeline offsets) renders nothing, never a guessed figure. Zero-denominator ratios display "undefined", never NaN.
- One categorical order (--viz-1..5: blue, orange, aqua, violet, magenta) shared by all figures, validated for CVD separation in light and dark; Heritage Gold stays the tutor's marker, never a data colour; slots 3 and 5 are under 3:1 on paper so every mark is text-labelled.
- Every tool part renders inside ToolPartErrorBoundary (#38). RENDERABLE_TOOL_NAMES must list every figure tool or the server's persistence gate drops the turn on replay. Lockstep tests: figures.test.tsx and toolkits.test.ts (client), routes/toolCatalog.test.ts (server tools are renderable or deliberately server-only; every pack tool exists server-side).
- knowledgeCheck (#36) has no answer field. The student's answer is a user message (text + data-knowledge-check-response part) that the server validates against the stored tool call and rebuilds (routes/knowledgeCheckAnswer.ts); the model judges it on the next turn.

## Known limits

Editing an llmoxie-provider config through the admin route fails ("Choose a provider."), because the route's PROVIDERS list predates LLMoxie (#107, #332). Until that lands, packs on the org's default LLMoxie config can't be changed from the console.

# Related Concepts
- [Chat messages store AI SDK UIMessage parts as jsonb instead of a message_type enum](messages-parts-jsonb.md): Figures persist as tool-<name> parts in messages.parts and replay through output-available; RENDERABLE_TOOL_NAMES gates which parts count as renderable on replay.
