---
type: Decision
title: One course-scoped student navigation column
description: Student Tutor Chats and Homeworks share one purple overview; selecting either enters detail and the back action returns to the overview. The student course switcher stays deferred to issue 70.
tags: [student, navigation, homework, tutor]
generated: { by: "codex:gpt-6", at: "2026-10-15T16:48:24Z" }
status: stable
---

The student workspace replaces the two independently collapsed rails with one purple column. Overview has Tutor Chats with an inline create button and Homeworks with all available assignments in the current course. Each selection opens detail; the back action returns to the overview with list expansion preserved. Homework state is keyed by assignment ID because section order numbers repeat across assignments; setters retain their originating homework ID to isolate late responses. Conversation components stay mounted while the overview is shown so returning does not discard the current draft. Until issue #70 supplies explicit student course selection, preserve the existing first-homework course choice and exclude other courses from both lists. See docs/design-system/components.md and apps/web/src/client/hooks/useStudentHomework.ts.

# Related Concepts
- [Stakeholder requirement: tutor and homework modes, code as bonus, leveled prompts](../requirements/stakeholder-homework-modes-and-assistance-levels.md): The unified navigation keeps open tutor sessions and section-based homework as distinct detail modes within the same course.
