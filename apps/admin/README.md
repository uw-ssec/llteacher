# llteacher-admin

Instructor-facing console for LLteacher. Sibling workspace to `apps/web/` in the Turborepo.

## Run

From the repo root:

```bash
npm install                # installs workspaces
npx turbo dev              # boots both web (2311) and admin (2312)
```

Or just this workspace:

```bash
npm run dev --workspace=llteacher-admin   # admin only on http://localhost:2312
```

## Scope

This is currently a **minimal scaffold**. It renders the shared UW Purple chrome (top nav + sidebar) with placeholder content. The instructor surfaces it will eventually own:

- Course / homework / section authoring
- Student roster and submission review
- Conversation grading (replaces Django's submission detail view)
- LLM configuration

## Shared design tokens — known duplication

`src/client/styles.css` is currently a **copy** of `apps/web/src/client/styles.css`. The next monorepo task is extracting both copies into a `packages/ui` shared workspace so the design system lives in one place. Until then, any token changes need to be made in both files.

## What admin does NOT have yet (vs. `apps/web/`)

- No Cloudflare Worker — admin is a static SPA in this scaffold. A Hono Worker will be added when admin needs an API.
- No Drizzle / Neon — same reason.
- No WorkOS / AI SDK / Wrangler — added when needed.

## Port

`2312` — sits next to web's `2311`. Both ports use Vite's `strictPort: true` so they fail loudly if taken rather than silently picking another.
