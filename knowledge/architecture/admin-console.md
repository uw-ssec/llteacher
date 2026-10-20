---
type: Architecture
title: Instructor admin console (apps/admin)
description: "The admin console marks destinations as unavailable to students, offers a validated course Student view with persistent preview chrome, and keeps instructor tutor and section tests separate from student activity."
tags: [architecture, admin, frontend]
generated: { by: "codex-app:gpt-6", at: "2026-10-20T16:33:39Z" }
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

**Runtime:** apps/admin is a client-only Vite app served at /admin/ by the web Node process. All data access uses the shared /api. Server authorization remains authoritative; console visibility gates are UX.

**Navigation:** every rendered console destination has a decorative EyeSlash marker. Hover or focus reveals Not visible to students below the row without covering content; Escape dismisses it until hover and focus leave. A nav-level note communicates this once to screen readers and touch users. Collapsed names remain concise. Existing authorOnly and superAdminOnly filters are unchanged. Student view is a separate navigation link.

**Student view:** the console launches view=student&courseId=<uuid> for an exact instructor/admin membership. The client deliberately requires that membership even for a platform super admin. Invalid links show a notice and console exit, including for mixed-role accounts. The preview notice remains during loading and errors and explains that unreleased content is hidden and student-record actions are disabled. Preview never impersonates a student. See apps/web/README.md for the canonical behavior and deployment contract.

**Data classification:** tutor and section chats created by non-students in the requested course are server-classified as teacher tests. They remain owner-scoped and persisted for reopening. Submit, self-assessment, section-answer, and feedback writes are omitted in preview and independently refused server-side. Teacher-test conversations are excluded from the unpublish student-activity warning. Existing student-owned rows after historical role changes are not migrated by this feature.

**Course context:** validated membership supplies context even with zero visible homework. Shared released-homework projection and stale-response guards preserve exact-course isolation. The outer course key remounts the workspace when the course changes; hook-level resets also protect standalone consumers.

**Deployment:** production and Floci share one origin, with the console at /admin/. VITE_ADMIN_URL overrides the return link. Loopback dev pairs are 2311/2312 and 2411/2412; LAN testing uses the bundled server. Admin API proxy defaults to localhost:8080. Tests use Vitest and Testing Library; real repository behavior requires DATABASE_URL.
