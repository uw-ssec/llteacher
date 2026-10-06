---
type: Architecture
title: Instructor admin console (apps/admin)
description: "apps/admin is a React 19 SPA built with base /admin/, served by the web Node process, calling the same /api; it owns homework authoring, LLM configs, roster, grading, transcripts, feedback, knowledge and Canvas views."
tags: [architecture, admin, frontend]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: context
code_refs: ["apps/admin/src/client/App.tsx", "apps/admin/src/client/views", "apps/admin/src/client/lib/api-client.ts", "apps/admin/vite.config.ts", "packages/ui/src", "packages/ui/package.json"]
sources:
  - resource: "apps/admin/vite.config.ts"
  - resource: "apps/web/src/node/server.ts"
  - resource: "ac34e17"
  - resource: "5c704c7"
---

`llteacher-admin` is a client-only Vite app (`root: src/client`, `base: /admin/`, build output `apps/admin/dist/admin`). It has no server and no DB access: every action goes through `/api/*` on the web Node process, which also serves the admin build at `/admin` (see architecture/request-path). Server-side authorization is the only real gate; the console's own gating (`isPlatformInstructor`, role checks) is UX.

**Views** (apps/admin/src/client/views): HomeworksView/HomeworkCreateView/HomeworkEditView/HomeworkReadOnlyView (authoring with section diffing via `lib/computeSectionDiff.ts`), LLMConfigsView/LLMConfigFormView, StudentsView (roster + CSV import), TaCapabilitiesView, SubmissionsView + GradingPanel (grading, AI draft grades), TranscriptListView/TranscriptDetailView, FeedbackDashboard (flagged tutor responses), KnowledgeView/KnowledgeDocumentView (OKF bundle browser with folder tree, Markdown cleanup), CanvasIntegrationView, ExportView, AddInstructorView (super-admin only).

**Shared code:** `@llteacher/ui` (packages/ui) is consumed as raw TS source through its `exports` map (`.`, `./styles.css`, `./auth/courseRole`, `./generative/renderableTools`, `./api`). It hand-mirrors the course role enum and holds `resolveTaCapabilities` and `readErrorMessage`, so server rules and console UX share one definition. apps/admin cannot import the Drizzle schema.

**Tests:** vitest + Testing Library in jsdom; ~454 tests in 35 files, no DB needed (`vitest run --passWithNoTests`).

**Stale doc warning:** apps/admin/README.md still says it is a "minimal scaffold" with "no Cloudflare Worker", and that styles are copied rather than shared. That predates M5 (#363) and packages/ui; the console is fully live.

**Dev:** port 2312 (`strictPort`). Its `/api` proxy target is `LLTEACHER_API_URL`, default `http://localhost:8080`, not 2311 or 3000; see facts/code-dev-ports-and-proxy. `VITE_ADMIN_URL` in the web build points staff users at the console.
