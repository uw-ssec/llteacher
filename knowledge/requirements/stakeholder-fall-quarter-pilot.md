---
type: Requirement
title: "Stakeholder requirement: usable for fall-quarter 2026 pilots"
description: "PIs need the platform working for courses starting about end of September 2026; issues labelled must-complete: fall-quarter (19 open, M7 RAG and M12 infra/cutover) define the minimum."
tags: [stakeholder, timeline, fall-quarter, scope]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["docs/notes"]
sources:
  - resource: "issue #67"
  - resource: "issue #66"
  - resource: "issue #44"
  - resource: "milestone M7"
  - resource: "milestone M12"
---

## Requirement

The four CDI projects run **fall-quarter 2026 pilots**. In the 2026-07-09 planning meeting the quarter start was given as about September 28–30. The stated plan was:

- mid-July: project plan
- end of July: baseline multi-user improvements (moving off single-user, SQLite-backed Django)
- end of August: user-specific features for the PIs
- September: testing and iteration

Project reports are due around mid-January (per SSEC context notes).

## How it is encoded on GitHub

- The label **`must-complete: fall-quarter`** is on 19 open issues, all in **M7 RAG & Course Materials** (#40–#44, #79) and **M12 Infra, Migration & Cutover** (#62–#66, #81–#84, #97, #163, #455, #456).
- Due dates: M7 and M12 were due 2026-09-17 and M9 FERPA 2026-09-30. All have passed with work remaining (see project/current-state).

## Implications for prioritisation

- As of 2026-10-06 the quarter has started. Production bring-up on AWS and the Django ETL (#64) are the critical path for moving the live stats course off Django.
- Course-grounded tutoring (RAG) was the most-requested cross-project capability. The OKF knowledge base partly delivers it, but the M7 issues have not been reconciled.
- FERPA work (M9) was scheduled for this window and is mostly open. Clinical informatics treats FERPA as a hard requirement.
- Nice-to-haves (M6 generative UI expansion, M8 analytics, M10 branding) were not on the must-complete list.
