---
type: Architecture
title: Instructor admin console (apps/admin)
description: "apps/admin is the instructor console; every console destination is visibly marked instructor-only, and authors can open a course-scoped Student view that previews as themselves while keeping tutor and teacher-test chats instructor-owned."
tags: [architecture, admin, frontend]
generated: { by: "codex-app:gpt-5", at: "2026-10-19T21:20:04Z" }
status: stable
governance: context
code_refs: [apps/admin/src/client/App.tsx, apps/admin/src/client/components/AdminSidebar.tsx, apps/admin/src/client/views, apps/admin/src/client/lib/api-client.ts, apps/web/src/client/App.tsx, apps/web/src/client/hooks/useStudentHomework.ts, apps/admin/vite.config.ts, packages/ui/src, packages/ui/package.json]
sources:
  - resource: docs/architecture/admin-console.md
  - resource: docs/design-system/components.md
  - resource: apps/web/README.md
  - resource: apps/admin/vite.config.ts
  - resource: apps/web/src/node/server.ts
  - resource: ac34e17
  - resource: 5c704c7
---

`llteacher-admin` is a client-only Vite app (`root: src/client`, `base: /admin/`, build output `apps/admin/dist/admin`). It has no server and no DB access: every action goes through `/api/*` on the web Node process, which also serves the admin build at `/admin` (see architecture/request-path). Server-side authorization is the only real gate; the console UI gates are UX.

**Views** (apps/admin/src/client/views): HomeworksView/HomeworkCreateView/HomeworkEditView/HomeworkReadOnlyView, LLMConfigsView/LLMConfigFormView, StudentsView, TaCapabilitiesView, SubmissionsView + GradingPanel, TranscriptListView/TranscriptDetailView, FeedbackDashboard, KnowledgeView/KnowledgeDocumentView, CanvasIntegrationView, ExportView, and AddInstructorView.

**Console-only navigation:** every rendered console destination carries an EyeSlash marker explained as **Only instructor viewable** on hover, keyboard focus, and through assistive text. Collapsed rows include the phrase in their accessible name and native title. The marker is descriptive only: existing author-only and super-admin-only filters remain the authority for which destinations render.

**Student view boundary:** an author can launch the selected course into the student app with `view=student&courseId=<uuid>`. The web app admits only an exact `instructor` or course `admin` membership and never falls back to another course. Preview runs as the instructor, never by impersonating a student. It uses the published/released student homework projection, keeps free-standing tutor chats owner-scoped to the instructor, and marks section conversations as teacher tests. Submit, self-assessment, section-answer, and response-feedback controls are absent. Course context comes from the validated membership, so tutor chats work even with zero visible homework.

**Shared code:** `@llteacher/ui` is consumed as raw TypeScript source through its exports map. It hand-mirrors the course role enum and holds shared authorization vocabulary, so server rules and console UX share one definition. apps/admin cannot import the Drizzle schema.

**Tests:** vitest + Testing Library in jsdom; no database is needed for the admin suite.

**Dev:** port 2312 (`strictPort`). Its `/api` proxy target is `LLTEACHER_API_URL`, default `http://localhost:8080`; see facts/code-dev-ports-and-proxy. `VITE_ADMIN_URL` in the web build points staff users back to the console.
