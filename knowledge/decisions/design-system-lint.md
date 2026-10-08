---
type: Decision
title: ShadCN lint enforces the shared UW design system
description: "Both client apps and packages/ui use six ShadCN lint rules in CI, with shared-theme discovery, explicit component contracts, and screenshot review."
tags: [design-system, lint, ui]
generated: { by: "codex:gpt-6", at: "2026-10-07T16:56:04Z" }
status: stable
---

The project owner requested design-system enforcement and screenshot verification. npm run lint:design-system checks production client TS/TSX and the UI package with six @shadcn/lint rules. components.json points at design-system.lint.css so lint can read the shared UW theme plus the account and knowledge-cleanup stylesheets. Existing Button restart/remove-section and EditableTitle row-title treatments have exact contracts; existing unstyled structural hooks have a finite named allowlist. Component implementations retain appearance ownership but still reject raw colors, inline styles, and unknown classes. Dynamic row delays and score widths use custom properties. npm run test:design-system proves every rule rejects representative drift. Adding ESLint makes AI SDK JSON Schema typings resolvable; chat route tests cast inputSchema to the exported Schema type. See docs/design-system/lint.md for contracts and review boundaries.

Screenshot review exposed existing mobile clipping and an invisible Spinner; the owner requested fixes. Below 800px, shared sidebars stack above the main column as bounded independently scrollable panels; collapse preferences and all navigation actions remain available. The shell uses dynamic viewport height and narrower content padding. Mobile catalog actions occupy their own grid row instead of overlapping titles. Desktop layout remains unchanged. Spinner now nests the sized dot beneath streaming-dot, matching the existing gold background, animation, and reduced-motion selectors; size selectors have enough specificity to retain 5/7/9px dimensions. Unit tests guard this structure.

scripts/design-system-screenshots.mjs renders real clients with deterministic API fixtures at 1440, 768, 390, and 320px. It asserts main/composer/message viewport containment, admin horizontal fit, sidebar toggle and scroll reachability, catalog action separation, and visible correctly sized Spinner dots in light/dark themes. It captures expanded and collapsed navigation. This verifies rendering, not live authentication or LLM behavior.

# Related Concepts
- [LLTeacher v2 system overview](../architecture/system-overview.md): The shared UI package and two clients are governed by this design-system lint policy.
