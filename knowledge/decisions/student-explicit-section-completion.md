---
type: Decision
title: Submit explicitly completes a section without requiring chat
description: The student Submit action records section completion regardless of chat participation; a student message is not required. Restart still voids the submission and homework completion still requires every section.
tags: [student, submission, completion]
generated: { by: "codex:gpt-6", at: "2026-10-15T17:08:05Z" }
status: stable
---

The project owner clarified on October 15, 2026 that clicking Submit means the student is done with the section regardless of chat activity. App.handleSubmit must not require a user-role message before posting the existing submission endpoint. A live section conversation is still the submission anchor, created when opening the section. Existing ownership and availability checks remain enforced by the server. A restart still voids the submission, and full homework completion is derived from every section being completed rather than from the homework publication status. Source: apps/web/src/client/App.tsx; regression: apps/web/src/client/App.test.tsx; UI contract: docs/design-system/components.md.

# Related Concepts
- [One course-scoped student navigation column](student-unified-navigation.md): The unified homework detail uses the explicit Submit completion action.
