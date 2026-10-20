# LLTeacher v2 — Documentation

Documentation for the LLTeacher v2 port and platform-generalization work. Source-of-truth implementation lives in the codebase; these docs cover the architecture decisions, design system, and active plans.

## Sections

| Section | Contents |
|---|---|
| [`architecture/`](./architecture/README.md) | Cross-cutting architectural concerns: Generative UI loop, dev API proxy, integration patterns |
| [`design-system/`](./design-system/README.md) | v2 design system: principles, tokens, components, aesthetic spec |
| [`superpowers/plans/`](./superpowers/plans/) | Implementation plans — dated `YYYY-MM-DD-<topic>.md`, executed task-by-task |

## Instructor Student view implementation record

- [Instructor Student View and Tutor Chat design](./superpowers/specs/2026-10-19-instructor-student-view-and-tutor-chat-design.md)
- [Instructor Student View and Tutor Chat implementation plan](./superpowers/plans/2026-10-19-instructor-student-view-and-tutor-chat.md)

## Onboarding guides

- [Superadmin Guide to Onboarding Instructors](./superadmin-instructor-onboarding.md)
- [Instructor Course Setup and Launch Checklist](./instructor-course-setup-checklist.md)

## Where things live in code

```
apps/
  web/                          Student-facing React app (Vite, Tailwind 4, useChat)
    src/client/                 React 19 client, App.tsx + components
    src/server/                 Hono Worker, routes (chat, hello), lib (ai)
    vite.config.ts              Vite config + dev API proxy
  admin/                        Instructor-facing app (same stack)
packages/
  ui/                           Shared design system: components, generative UI renderers, styles.css
docs/
  architecture/                 This section — cross-cutting docs
  design-system/                Design system reference
  superpowers/plans/            Implementation plans
```

## Conventions

- **Plans** are dated `YYYY-MM-DD-<topic>.md` and live under `superpowers/plans/`. They are executed task-by-task via the subagent-driven-development workflow.
- **Architecture docs** describe how something works *today*. They are not aspirational — when behavior changes, the doc gets updated.
- **Design system docs** describe component contracts and visual spec. New components and new tools both get an entry.
