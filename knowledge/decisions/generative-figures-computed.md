---
type: Decision
title: Subject figures compute what they assert; the model supplies only arguments
description: "ECON 201 and bioinformatics generative-UI figures (and shared worked steps) draw from model arguments but compute every outcome, number and sentence in packages/ui/src/generative/lib; deny-by-default parsers render nothing on bad input."
tags: [generative-ui, econ, bioinformatics, dataviz]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:19:55Z" }
status: stable
---

## Decision

Nine display tools render inline figures: shared showWorkedSteps; ECON 201 showMacroModel, showGdpComposition, showMultiplier, showLaborForce, showInflation; bioinformatics showAlignment, showTranslation, showPhyloTree. The model names WHAT to draw (which curve shifts which way, the components, the sequence); the figure COMPUTES the consequences: equilibrium movement and output gap, GDP and shares, multiplier and rounds, unemployment/participation rates, inflation, the standard-genetic-code translation, alignment identity and score, Newick layout. Models misremember codons and assert wrong directions of change; this makes the picture and its takeaway unable to contradict each other or the subject. Only WorkedSteps presents the tutor's own arithmetic, and it states no computed takeaway for that reason.

## Invariants

- Each tool has a deny-by-default parser (packages/ui/src/generative/toolInputs.ts): wrong type OR wrong meaning (MPC outside (0,1), unequal aligned lengths, unknown curve, invalid Newick) renders nothing, never a guessed figure.
- One categorical order (--viz-1..5: blue, orange, aqua, violet, magenta) shared by all figures, validated for CVD separation in light and dark; Heritage Gold stays the tutor's marker, never a data colour; slots 3 and 5 are under 3:1 on paper so every mark is text-labelled.
- Every tool part renders inside ToolPartErrorBoundary (#38). RENDERABLE_TOOL_NAMES must list every figure tool or the server's persistence gate drops the turn on replay; figures.test.tsx enforces the lockstep.

## Known limits

All courses are offered all nine tools (no course-subject field to gate on); the descriptions name the subject. #36 (interactive knowledge check) and #35 (statistics distribution plot) remain open.

# Related Concepts
- [Chat messages store AI SDK UIMessage parts as jsonb instead of a message_type enum](messages-parts-jsonb.md): Figures persist as tool-<name> parts in messages.parts and replay through output-available; RENDERABLE_TOOL_NAMES gates which parts count as renderable on replay.
