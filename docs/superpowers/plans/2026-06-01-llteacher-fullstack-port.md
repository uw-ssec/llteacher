# LLteacher Full-Stack Port to TS/React/Vite/Cloudflare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement Phase 0 task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Scope note:** This is a **master plan** covering 12 phases (0–11). **Only Phase 0 (scaffolding) is at execution-ready detail.** Phases 1–11 are scoped milestones; each must be run through `/superpowers:writing-plans` against its own scope to produce execution-ready tasks before implementation. Do not attempt to execute Phases 1–11 from this document.
>
> **Commit policy (user instruction):** No `Co-Authored-By:` trailers on commits or PR descriptions. User handles commits via their own `/commit`/`/push` workflow.

**Goal:** Replace the Django stack with a TypeScript + React 19 + Vite + Tailwind 4 application running on Cloudflare Workers, backed by Neon Postgres via Drizzle ORM, authenticated with WorkOS, talking to LLMs via the Vercel AI SDK + OpenRouter. Achieve feature parity with the current Django app first, then layer multi-tenancy / Canvas LTI / RAG on top.

**Architecture:**
- **Frontend:** React 19 + Vite + TypeScript + Tailwind 4, served as static assets from a Cloudflare Worker.
- **Backend:** Single Hono app inside the same Worker, exposing JSON + SSE endpoints.
- **Data:** Neon Postgres with the `@neondatabase/serverless` HTTP driver + Drizzle ORM + pgvector extension (enabled now even if unused until Phase 8).
- **Auth:** WorkOS (AuthKit) for SSO-ready user management.
- **LLM:** Vercel AI SDK as the streaming/tool-call client; OpenRouter as the provider so each course can route to any model.
- **R execution:** Continue loading WebR client-side from `webr.r-wasm.org` (unchanged).

**Tech Stack:** TypeScript 5.7+, React 19, Vite 6+, Tailwind 4, Hono 4+, Cloudflare Workers (with static asset bindings), Drizzle ORM, `@neondatabase/serverless`, `pgvector` PG extension, WorkOS Node SDK, Vercel AI SDK 5+, OpenRouter, Vitest, Playwright (later phases), Wrangler.

**Decisions made:**
- `web/` is a new subdirectory in the existing repo. Django stays running under `apps/`, `src/`, `services/` until cutover (Phase 11). Single repo, single git history.
- React Server Components are **not** used in v1. Plain client-side React with React Router-style routing. SSR/RSC can be revisited after parity if needed.
- Convex is **out**. Drizzle + Neon covers the data needs; mixing Convex with a SQL ORM is duplication.
- AG-UI / A2UI are **out** of v1. Vercel AI SDK + the standard `useChat` pattern handles streaming; the experimental UI protocols can be evaluated post-parity.
- pgvector is installed and migrated now, but no embeddings until Phase 8 RAG.

---

## Phase Dependency Graph

```
Phase 0: Scaffolding (this session)
    │
    ▼
Phase 1: Drizzle schema port  ◄─── mirror of Django models
    │
    ▼
Phase 2: Auth port (WorkOS)
    │
    ▼
Phase 3: LLM service port (Vercel AI SDK + OpenRouter, streaming)
    │
    ├──────────────┬──────────────┬──────────────┐
    ▼              ▼              ▼              ▼
Phase 4:       Phase 5:       Phase 6:       Phase 7:
Accounts UI    Homeworks UI   Conversations  LLM config UI
                              UI + R exec
    │              │              │              │
    └──────────────┴──────┬───────┴──────────────┘
                          ▼
                  Phase 8: Admin replacement
                          │
                          ▼
                  Phase 9: Seed/test fixtures
                          │
                          ▼
                  Phase 10: Data migration (SQLite → Neon)
                          │
                          ▼
                  Phase 11: Cutover + Django retirement
```

Calendar-week estimate against a 2–3 engineer SSE pod with AI-assisted dev:
- Phase 0: this session (1–2 hours)
- Phase 1: 2–3 days
- Phase 2: 3–5 days
- Phase 3: 5–7 days (streaming is the gnarly part)
- Phase 4: 3–4 days
- Phase 5: 5–7 days
- Phase 6: 7–10 days (R execution wiring, SSE rendering)
- Phase 7: 2–3 days
- Phase 8: 3–4 days
- Phase 9: 2 days
- Phase 10: 3–4 days
- Phase 11: 2 days

**Total:** ~8–10 weeks of focused engineering for feature parity. Platform features (multi-tenancy, Canvas LTI, RAG embeddings) come after parity and slot into the prior `2026-06-01-llteacher-platform-generalization.md` roadmap.

---

## Phase 0: Scaffolding

**Goal:** Stand up `web/` as a working Vite + React 19 + TS + Tailwind 4 frontend and a Hono Cloudflare Worker backend, wired to Drizzle + Neon, with WorkOS and Vercel AI SDK dependencies installed, Vitest configured, and an end-to-end "hello world" smoke test proving the loop: React page → Hono API → Neon → JSON → render.

**File Structure (final state at end of Phase 0):**

```
llteacher/
├── apps/             # existing Django (unchanged)
├── src/              # existing Django (unchanged)
├── services/         # existing Django (unchanged)
├── web/              # NEW — TS/React/Vite/Workers app
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── vite.config.ts
│   ├── wrangler.jsonc
│   ├── drizzle.config.ts
│   ├── vitest.config.ts
│   ├── .gitignore
│   ├── .dev.vars.example
│   ├── README.md
│   ├── public/
│   │   └── favicon.ico
│   └── src/
│       ├── client/
│       │   ├── main.tsx            # React 19 entry
│       │   ├── App.tsx             # Hello-world page calling /api/hello
│       │   ├── index.html
│       │   └── styles.css          # Tailwind 4 entry
│       ├── server/
│       │   ├── index.ts            # Worker entry; Hono app + asset serving
│       │   └── routes/
│       │       └── hello.ts        # GET /api/hello → reads from DB
│       ├── db/
│       │   ├── schema.ts           # Drizzle schemas (minimal: a `pings` table)
│       │   ├── client.ts           # Neon HTTP client + Drizzle wrapper
│       │   └── migrations/         # generated by drizzle-kit
│       ├── lib/
│       │   ├── workos.ts           # WorkOS SDK wrapper (stub for Phase 2)
│       │   └── ai.ts               # Vercel AI SDK + OpenRouter wrapper (stub for Phase 3)
│       └── shared/
│           └── types.ts            # API response shapes
└── docs/superpowers/plans/  # this plan + future plans
```

**Test commands:**
```bash
cd web && npm run test          # Vitest
cd web && npm run dev           # Vite + Wrangler dev (proxied)
cd web && npm run build         # Vite build
cd web && npm run typecheck     # tsc --noEmit
```

**Environment variables (in `web/.dev.vars` — never commit):**
- `DATABASE_URL` — Neon connection string
- `WORKOS_API_KEY` — placeholder for Phase 2
- `WORKOS_CLIENT_ID` — placeholder for Phase 2
- `OPENROUTER_API_KEY` — placeholder for Phase 3

`.dev.vars.example` is committed with placeholder values; `.dev.vars` is gitignored.

---

### Task 0.1: Create `web/` directory, initial `package.json`, `.gitignore`, and `README.md`

**Files:**
- Create: `web/package.json`
- Create: `web/.gitignore`
- Create: `web/README.md`
- Create: `web/.dev.vars.example`

- [ ] **Step 1: Create the `web/` directory**

```bash
mkdir -p /Users/corderocore/Documents/llteacher/web
cd /Users/corderocore/Documents/llteacher/web
```

- [ ] **Step 2: Create `web/package.json`**

Write `web/package.json`:

```json
{
  "name": "llteacher-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@neondatabase/serverless": "^0.10.0",
    "@workos-inc/node": "^7.0.0",
    "ai": "^5.0.0",
    "drizzle-orm": "^0.36.0",
    "hono": "^4.6.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router": "^7.0.0"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.0.0",
    "@cloudflare/workers-types": "^4.20250101.0",
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "drizzle-kit": "^0.28.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.95.0"
  }
}
```

- [ ] **Step 3: Create `web/.gitignore`**

Write `web/.gitignore`:

```
node_modules/
dist/
.dev.vars
.wrangler/
.vite/
*.log
.DS_Store
coverage/
```

- [ ] **Step 4: Create `web/.dev.vars.example`**

Write `web/.dev.vars.example`:

```
DATABASE_URL="postgresql://user:password@host.neon.tech/llteacher?sslmode=require"
WORKOS_API_KEY="sk_test_placeholder"
WORKOS_CLIENT_ID="client_placeholder"
OPENROUTER_API_KEY="sk-or-v1-placeholder"
```

- [ ] **Step 5: Create `web/README.md`**

Write `web/README.md`:

```markdown
# llteacher-web

TypeScript / React 19 / Vite / Tailwind 4 / Hono / Cloudflare Workers / Drizzle / Neon port of LLteacher.

## Setup

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and fill in real values.
3. `npm run db:migrate` (after Drizzle schema exists in Phase 1).
4. `npm run dev` to start Vite + Wrangler in dev mode.

## Phase 0 status

Scaffolding only. Auth, LLM, real routes land in subsequent phases (see `../docs/superpowers/plans/`).
```

- [ ] **Step 6: Install dependencies**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm install
```

Expected: dependency tree installs cleanly. If versions of React 19 / Tailwind 4 / Vite 6 have moved, accept latest stable.

- [ ] **Step 7: Commit (without Co-Authored-By trailer)**

Stage the new files and let the user invoke `/commit` and `/push` from their own workflow. Print to the user:

```
Phase 0 Task 1 staged: web/package.json, web/.gitignore, web/.dev.vars.example, web/README.md.
Run /commit to record this checkpoint.
```

Do **not** invoke `git commit` directly unless the user explicitly requests it.

---

### Task 0.2: TypeScript + Vite + React 19 scaffolding

**Files:**
- Create: `web/tsconfig.json`, `web/tsconfig.node.json`
- Create: `web/vite.config.ts`
- Create: `web/src/client/index.html`
- Create: `web/src/client/main.tsx`
- Create: `web/src/client/App.tsx`

- [ ] **Step 1: Write `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["@cloudflare/workers-types", "vite/client"]
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 2: Write `web/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts", "vitest.config.ts", "drizzle.config.ts"]
}
```

- [ ] **Step 3: Write `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss(), cloudflare()],
});
```

- [ ] **Step 4: Write `web/src/client/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.ico" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LLteacher</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `web/src/client/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Write `web/src/client/App.tsx`**

```tsx
import { useEffect, useState } from "react";

type HelloResponse = { message: string; ping_id: string };

export default function App() {
  const [hello, setHello] = useState<HelloResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/hello")
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<HelloResponse>;
      })
      .then(setHello)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 text-slate-900">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">LLteacher (Cloudflare port)</h1>
        {error && <p className="mt-4 text-red-600">Error: {error}</p>}
        {hello && (
          <p className="mt-4 text-slate-700">
            {hello.message} <code className="text-xs text-slate-500">{hello.ping_id}</code>
          </p>
        )}
        {!hello && !error && <p className="mt-4 text-slate-500">Loading…</p>}
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Run typecheck**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm run typecheck
```

Expected: PASS (no type errors).

- [ ] **Step 8: Stage and report — let the user `/commit`**

Files staged: `web/tsconfig.json`, `web/tsconfig.node.json`, `web/vite.config.ts`, `web/src/client/index.html`, `web/src/client/main.tsx`, `web/src/client/App.tsx`.

---

### Task 0.3: Tailwind 4 styling

**Files:**
- Create: `web/src/client/styles.css`

- [ ] **Step 1: Write `web/src/client/styles.css`**

Tailwind 4 uses a CSS-first config — no `tailwind.config.js` required for v1.

```css
@import "tailwindcss";

@theme {
  --font-sans: "Inter", system-ui, sans-serif;
}

html, body, #root {
  height: 100%;
  margin: 0;
}
```

- [ ] **Step 2: Run dev server to verify Tailwind compiles**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm run dev
```

Visit the local URL Vite prints. Expected: the hello-world page renders with Tailwind classes applied (rounded card, slate colors, centered).

The fetch to `/api/hello` will still fail at this point because the Worker hasn't been wired yet — that's Task 0.5. The error message "Error: ..." should be visible, confirming React + Tailwind work.

Stop the dev server with Ctrl-C.

- [ ] **Step 3: Stage and report — let the user `/commit`**

Files staged: `web/src/client/styles.css`.

---

### Task 0.4: Hono + Cloudflare Worker setup

**Files:**
- Create: `web/wrangler.jsonc`
- Create: `web/src/server/index.ts`
- Create: `web/src/server/routes/hello.ts`
- Create: `web/src/shared/types.ts`

- [ ] **Step 1: Write `web/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "llteacher-web",
  "main": "src/server/index.ts",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },
  "observability": {
    "enabled": true
  },
  "vars": {
    // Non-secret vars go here. Secrets live in .dev.vars locally and Wrangler secrets in prod.
  }
}
```

- [ ] **Step 2: Write `web/src/shared/types.ts`**

```ts
export type HelloResponse = {
  message: string;
  ping_id: string;
};
```

- [ ] **Step 3: Write `web/src/server/routes/hello.ts`**

Stub for now — DB call lands in Task 0.6.

```ts
import { Hono } from "hono";
import type { HelloResponse } from "../../shared/types";

export const hello = new Hono<{ Bindings: Env }>();

hello.get("/", (c) => {
  const resp: HelloResponse = {
    message: "Hono Worker is alive.",
    ping_id: crypto.randomUUID(),
  };
  return c.json(resp);
});
```

- [ ] **Step 4: Write `web/src/server/index.ts`**

```ts
import { Hono } from "hono";
import { hello } from "./routes/hello";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/hello", hello);

export default app;
```

- [ ] **Step 5: Add `Env` type — append to `web/src/shared/types.ts`**

Replace `web/src/shared/types.ts` with:

```ts
export type HelloResponse = {
  message: string;
  ping_id: string;
};

// Cloudflare Worker bindings + secrets. Augmented in Phase 1+.
declare global {
  interface Env {
    DATABASE_URL: string;
    WORKOS_API_KEY: string;
    WORKOS_CLIENT_ID: string;
    OPENROUTER_API_KEY: string;
    ASSETS: Fetcher;
  }
}

export {};
```

- [ ] **Step 6: Typecheck**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Boot dev server end-to-end**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm run dev
```

Visit the printed URL. Expected: React page renders, `/api/hello` returns JSON, the page shows "Hono Worker is alive." with a UUID.

Stop with Ctrl-C.

- [ ] **Step 8: Stage and report — let the user `/commit`**

Files staged: `web/wrangler.jsonc`, `web/src/server/index.ts`, `web/src/server/routes/hello.ts`, `web/src/shared/types.ts`.

---

### Task 0.5: Drizzle + Neon connection

**Files:**
- Create: `web/drizzle.config.ts`
- Create: `web/src/db/schema.ts`
- Create: `web/src/db/client.ts`
- Modify: `web/src/server/routes/hello.ts` (read from DB)

- [ ] **Step 1: Write `web/drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
```

- [ ] **Step 2: Write `web/src/db/schema.ts`**

Minimal schema for the smoke test. Real schema port lands in Phase 1.

```ts
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const pings = pgTable("pings", {
  id: uuid("id").primaryKey().defaultRandom(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 3: Write `web/src/db/client.ts`**

```ts
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

export function makeDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof makeDb>;
```

- [ ] **Step 4: Update `web/src/server/routes/hello.ts` to insert + read a ping**

```ts
import { Hono } from "hono";
import { makeDb } from "../../db/client";
import { pings } from "../../db/schema";
import type { HelloResponse } from "../../shared/types";

export const hello = new Hono<{ Bindings: Env }>();

hello.get("/", async (c) => {
  const db = makeDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(pings)
    .values({ message: "Hello from Hono + Drizzle + Neon." })
    .returning();
  const resp: HelloResponse = {
    message: row.message,
    ping_id: row.id,
  };
  return c.json(resp);
});
```

- [ ] **Step 5: Prompt the user for a Neon `DATABASE_URL`**

If a `.dev.vars` file doesn't exist yet, the user must create one from the example. Print to the user:

```
Phase 0 needs a Neon Postgres database URL.

1. Create a free Neon project at https://console.neon.tech (or reuse one).
2. Copy the "Connection string" (the pooled one).
3. Create web/.dev.vars (copy from .dev.vars.example) and set DATABASE_URL.
4. Run /loop or tell me when ready and I'll proceed with `db:generate` + `db:migrate`.
```

Do not proceed with steps 6–8 until the user confirms.

- [ ] **Step 6: Generate the initial migration**

```bash
cd /Users/corderocore/Documents/llteacher/web && npx drizzle-kit generate
```

Expected: a SQL file appears under `web/src/db/migrations/`.

- [ ] **Step 7: Apply the migration to Neon**

```bash
cd /Users/corderocore/Documents/llteacher/web && npx drizzle-kit migrate
```

Expected: the `pings` table is created in Neon. Confirm via `npx drizzle-kit studio` if desired.

- [ ] **Step 8: End-to-end smoke**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm run dev
```

Visit the page. Expected: it loads, fetches `/api/hello`, displays "Hello from Hono + Drizzle + Neon." and a UUID that increments on refresh (each refresh inserts a new row). Confirm the rows in `pings` via `drizzle-kit studio` or a `psql` query.

Stop with Ctrl-C.

- [ ] **Step 9: Stage and report — let the user `/commit`**

Files staged: `web/drizzle.config.ts`, `web/src/db/schema.ts`, `web/src/db/client.ts`, `web/src/db/migrations/*`, `web/src/server/routes/hello.ts`.

---

### Task 0.6: WorkOS SDK scaffold (no auth yet)

**Files:**
- Create: `web/src/lib/workos.ts`

- [ ] **Step 1: Write `web/src/lib/workos.ts`**

Stub — full auth lands in Phase 2.

```ts
import { WorkOS } from "@workos-inc/node";

let cached: WorkOS | null = null;

export function getWorkOS(apiKey: string): WorkOS {
  if (!cached) {
    cached = new WorkOS(apiKey);
  }
  return cached;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Stage and report — let the user `/commit`**

---

### Task 0.7: Vercel AI SDK + OpenRouter scaffold (no LLM call yet)

**Files:**
- Create: `web/src/lib/ai.ts`

- [ ] **Step 1: Write `web/src/lib/ai.ts`**

Stub — real LLM streaming lands in Phase 3.

```ts
import { createOpenAI } from "@ai-sdk/openai";

export function getOpenRouter(apiKey: string) {
  return createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": "https://llteacher.uw.edu",
      "X-Title": "LLteacher",
    },
  });
}
```

- [ ] **Step 2: Install the `@ai-sdk/openai` provider package**

The Vercel AI SDK splits providers into separate packages. Add `@ai-sdk/openai`:

```bash
cd /Users/corderocore/Documents/llteacher/web && npm install @ai-sdk/openai
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Stage and report — let the user `/commit`**

---

### Task 0.8: Vitest setup + first server-side test

**Files:**
- Create: `web/vitest.config.ts`
- Create: `web/src/server/routes/hello.test.ts`

- [ ] **Step 1: Write `web/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
```

- [ ] **Step 2: Write `web/src/server/routes/hello.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { hello } from "./hello";

vi.mock("../../db/client", () => ({
  makeDb: () => ({
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: "00000000-0000-0000-0000-000000000001", message: "mocked" }],
      }),
    }),
  }),
}));

describe("GET /api/hello", () => {
  it("returns a HelloResponse with mocked message and ping_id", async () => {
    const res = await hello.request("/", {}, { DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      message: "mocked",
      ping_id: "00000000-0000-0000-0000-000000000001",
    });
  });
});
```

- [ ] **Step 3: Run the test**

```bash
cd /Users/corderocore/Documents/llteacher/web && npm test
```

Expected: PASS (1 test, 1 assertion). If the mock shape is wrong, refine until green.

- [ ] **Step 4: Stage and report — let the user `/commit`**

---

### Task 0.9: Root README pointer

**Files:**
- Modify: `README.md` (root)

- [ ] **Step 1: Add a short pointer at the top of the root `README.md`**

Insert immediately after the `# LLTeacher v2` title:

```markdown
> **Port in progress:** A TypeScript / React 19 / Vite / Tailwind 4 / Cloudflare Workers
> rewrite is being built in `web/`. The current Django app remains the source of truth
> until cutover. See `docs/superpowers/plans/2026-06-01-llteacher-fullstack-port.md`.
```

- [ ] **Step 2: Stage and report — let the user `/commit`**

---

### Phase 0 Done-Definition

Run everything from a clean state and confirm:

- [ ] `cd web && npm install` succeeds.
- [ ] `cd web && npm run typecheck` returns 0.
- [ ] `cd web && npm test` returns 0 with at least one passing test.
- [ ] `cd web && npm run dev` boots; visiting the local URL renders the React + Tailwind hello page; the page shows a message read from Neon via Drizzle; each refresh produces a fresh `ping_id` UUID and adds a row to `pings`.
- [ ] The Django app under `apps/`, `src/`, `services/` is unchanged and still passes its own test suite: `uv run python run_tests.py --settings=src.llteacher.test_settings`.

If all five hold, Phase 0 ships and we can hand the next phase off to its own `/superpowers:writing-plans` run.

---

## Phase 1: Drizzle Schema Port

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Mirror the Django ORM models (`accounts.User/Teacher/Student`, `homeworks.Homework/Section/SectionSolution`, `conversations.Conversation/Message/Submission`, `llm.LLMConfig`) as Drizzle schemas in `web/src/db/schema.ts`, plus enable the `pgvector` extension for future RAG.

**Depends on:** Phase 0.

**Files affected:**
- Modify: `web/src/db/schema.ts` — full schema with FKs, indexes, constraints
- Create: `web/src/db/relations.ts` — Drizzle relations API definitions
- Create: `web/src/db/migrations/0001_pgvector.sql` — `CREATE EXTENSION IF NOT EXISTS vector;`
- Create: per-table query helpers under `web/src/db/queries/`
- Update: `web/wrangler.jsonc` if any new bindings are needed

**Key design questions to settle in brainstorming:**
1. Mirror the Django models 1:1 (preserve `db_table` names) so Phase 10 data migration can be a straight pg_dump → restore? Or normalize away the per-app `db_table` prefixes?
2. UUID PK strategy: `uuid().defaultRandom()` matches Django's `uuid.uuid4`, but does the data migration require generating new UUIDs for join-table rows?
3. The Django `Message.message_type` is free-text `CharField(50)` with class constants. Port as a pg enum or keep as `text`? (Enums are stricter but require migrations to add new types like `code_execution`.)
4. The teacher/student profile pattern: keep two separate tables (`teachers`, `students`) or collapse into `users.role`? Current Django serializes both via `hasattr(user, 'teacher_profile')`.
5. `is_default` enforcement on `llm_configs`: model `.save()` clears the flag on others. Port via partial unique index, trigger, or service-layer logic?
6. Soft delete on `Conversation`: keep `is_deleted`/`deleted_at` or move to a partial index + view?
7. Add the `Organization` / `Course` multi-tenancy layer now or in a later phase? (Current answer per AskUserQuestion is "port to parity first, then platform features" — so defer.)

**Estimated effort:** 2–3 days with AI-assisted dev.

**Next step:** `/superpowers:brainstorming` against the questions above, then `/superpowers:writing-plans`.

---

## Phase 2: Auth Port (WorkOS)

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Replace Django session auth + custom `User`/`Teacher`/`Student` profile model with WorkOS-managed identity. Preserve role distinction (instructor vs student). Provide login, registration (if applicable; WorkOS may handle this via AuthKit), logout, and a session middleware for Hono routes.

**Depends on:** Phases 0, 1.

**Files affected:**
- Create: `web/src/server/middleware/auth.ts` — Hono middleware verifying WorkOS sessions
- Create: `web/src/server/routes/auth.ts` — login/callback/logout endpoints
- Create: `web/src/lib/session.ts` — session cookie reading/writing (Workers KV or signed JWT)
- Create: `web/src/client/auth/AuthProvider.tsx` — React context for current user
- Create: `web/src/client/auth/LoginButton.tsx`, `LogoutButton.tsx`
- Modify: `web/src/server/index.ts` — wire auth middleware

**Key design questions to settle in brainstorming:**
1. WorkOS AuthKit (hosted UI) or custom UI on top of WorkOS APIs? AuthKit ships fastest; custom matches the Django UI more closely.
2. Session storage — Workers KV, encrypted cookie, or D1? Workers KV has eventual consistency; encrypted cookie is stateless.
3. Role assignment — store `role` in WorkOS user metadata, in our `users` table, or both (synced)?
4. Email-domain restriction (current Django dev setting `ALLOWED_EMAIL_DOMAINS = ['uw.edu']`) — enforce at WorkOS organization level or in our middleware?
5. Migration from Django sessions: do existing users need to re-authenticate? (Almost certainly yes.)
6. For Phase 5 Canvas LTI, identities will need to map to WorkOS users — design that mapping now or later?

**Estimated effort:** 3–5 days.

**Next step:** `/superpowers:brainstorming` then `/superpowers:writing-plans`.

---

## Phase 3: LLM Service Port (Vercel AI SDK + OpenRouter, streaming)

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Re-implement `LLMService.get_response` and `LLMService.stream_response` (currently `apps/llm/src/llm/services.py:101–253`) in TS, using the Vercel AI SDK's `streamText` / `generateText` against OpenRouter. Preserve the current behavior: build conversation history from `Message` rows, assemble per-turn prompt with homework + section context, stream tokens to a Hono SSE endpoint, persist AI messages with per-token updates.

**Depends on:** Phases 0, 1, 2.

**Files affected:**
- Create: `web/src/server/services/llm.ts` — context build + `streamText`/`generateText`
- Create: `web/src/server/services/conversation.ts` — `processMessage` orchestrating user-message persist → stream call → AI-message persist
- Create: `web/src/server/routes/conversations/stream.ts` — SSE endpoint matching current `/conversations/api/<id>/stream/` shape
- Tests: `web/src/server/services/llm.test.ts` (mock the AI SDK provider)

**Key design questions to settle in brainstorming:**
1. The Vercel AI SDK uses its own event protocol (`useChat` data stream format). Match it for free client integration? Or keep the current custom SSE event shape (`user_message`, `ai_message_start`, `ai_token`, `ai_message_complete`) for backwards compat with the existing client logic (which is being thrown away anyway)?
2. Per-token DB writes — the Django code calls `ai_message.save()` after every token. Port verbatim, or batch (every N tokens / every M ms)? Cloudflare egress to Neon may cost more in the naive case.
3. Where does the system-prompt + per-turn prompt assembly live? `_build_current_prompt` interpolates homework + section title + content; this is the bulk of the LLM contract and should be testable in isolation.
4. Token usage tracking — current Django code drops it. Vercel AI SDK exposes it via `stream.usage`. Persist now or later?
5. R code messages and code-execution result messages are replayed as `"user"` role today. Preserve or change? (See Phase 2 of the Django plan for the context.)
6. Error handling pattern — Django generates a UUID error ID and returns it in user-facing text. Mirror, or use richer structured errors?

**Estimated effort:** 5–7 days. Streaming + persistence + testing is the hardest part of the entire port.

**Next step:** `/superpowers:brainstorming` then `/superpowers:writing-plans`.

---

## Phase 4: Accounts UI Port

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Port the three accounts templates (`login.html`, `register.html`, `profile.html`) to React components backed by WorkOS auth + a profile API.

**Depends on:** Phases 0, 1, 2.

**Files affected:**
- Create: `web/src/client/routes/Login.tsx`, `Register.tsx`, `Profile.tsx`
- Create: `web/src/client/components/Form*` (shared form pieces)
- Create: `web/src/server/routes/profile.ts` — GET/PATCH profile
- Update: `web/src/client/main.tsx` — wire React Router 7

**Key design questions:**
1. Public registration (Django allows student-only registration; teachers are created in admin). Mirror, or have WorkOS handle the whole thing?
2. Profile fields displayed: today the profile page shows `courses_created` for teachers and placeholder zeros for students. Reproduce or trim?
3. UW email-domain restriction — see Phase 2.

**Estimated effort:** 3–4 days.

---

## Phase 5: Homeworks UI Port

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Port the five homeworks templates (`list.html`, `detail.html`, `section_detail.html`, `form.html`, `submissions.html`) to React components and the corresponding API endpoints.

**Depends on:** Phases 0, 1, 2.

**Files affected:**
- Create: `web/src/client/routes/homeworks/{List,Detail,SectionDetail,Form,Submissions}.tsx`
- Create: `web/src/server/routes/homeworks.ts` — CRUD endpoints
- Create: `web/src/server/services/homework.ts` — port of `HomeworkService` (~700 lines of Django service)
- Create: section formset replacement — likely a Field Array via `react-hook-form` or similar

**Key design questions:**
1. The Django `HomeworkService.get_homework_submissions` builds a students × sections matrix with participation statuses. Reproduce as-is in TS, or simplify the view model?
2. Markdown rendering: current templates use `<md-block>` from a CDN. React replacement — `react-markdown` + `remark-gfm` + `rehype-highlight`?
3. Section formsets are tricky in Django; do them as a `react-hook-form` field array with explicit ordering controls.
4. Bootstrap → Tailwind: the existing UI is Bootstrap accordions, badges, progress bars. Pick a Tailwind component library (shadcn/ui? Headless UI? roll your own?) and commit.

**Estimated effort:** 5–7 days.

---

## Phase 6: Conversations UI Port (with R execution + SSE)

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Port `conversations/detail.html`, `start.html`, `message_form.html` plus the three custom JS files (`real-time-chat.js`, `r-execution-manager.js`, `conversation-detail.js`). React + Vercel AI SDK `useChat` for streaming. WebR (`https://webr.r-wasm.org/latest/webr.mjs`) remains client-side, now driven by a React hook instead of vanilla JS.

**Depends on:** Phases 0, 1, 2, 3.

**Files affected:**
- Create: `web/src/client/routes/conversations/{Start,Detail}.tsx`
- Create: `web/src/client/hooks/{useChat,useWebR,useRExecution}.ts`
- Create: `web/src/client/components/{ChatMessage,ChatComposer,RCodeBlock,RCodeRunner}.tsx`
- Create: `web/src/server/routes/conversations.ts` — start, send, stream, submit, delete-and-restart
- Wire up Prism highlighting (or shiki) for code rendering

**Key design questions:**
1. Vercel AI SDK's `useChat` versus a custom SSE reader matching the existing event shape? `useChat` is opinionated about message format.
2. WebR loading: dynamic import inside a React effect, or a top-level script? Same CDN URL either way.
3. `ImageBitmap` plot rendering: continue using `<canvas>` + `ctx.drawImage`, or convert to PNG and use `<img>`?
4. Server-side `handleRCodeExecution` (currently unused — JS doesn't POST results back): wire it now or leave dormant?
5. The current Django code saves the AI message per token. Vercel AI SDK's stream finalization can do a single save on completion. Behavior change — accept?

**Estimated effort:** 7–10 days. This is the most complex UI surface.

---

## Phase 7: LLM Config UI Port

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Port `llm/config_list.html`, `config_detail.html`, `config_form.html` to React. Surface `base_url`, model picker, `is_default` toggle, test endpoint.

**Depends on:** Phases 0, 1, 2, 3.

**Estimated effort:** 2–3 days.

---

## Phase 8: Admin Replacement

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Django's `/admin/` provides table-level CRUD for all models. Replace with either (a) a curated admin React surface, (b) directly using `drizzle-kit studio` for power users, or (c) a third-party admin (e.g., Pocketbase-style — none fits cleanly on Workers).

**Estimated effort:** 3–4 days.

**Key design question:** is there an admin user persona this product needs, or are all admin actions doable through the instructor UI?

---

## Phase 9: Seed / Test Fixtures Port

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Port `src/llteacher/management/commands/populate_test_database.py` to a TS script (`web/scripts/seed.ts`) that uses Drizzle to populate the same teachers, students, homeworks, sections, LLM config, conversations, and submissions.

**Estimated effort:** 2 days.

---

## Phase 10: Data Migration (SQLite → Neon)

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** One-shot ETL from the live Django SQLite DB (running Sara's 180-student stats class) to Neon Postgres, matching the Drizzle schema. Includes user identity mapping (Django user → WorkOS user — almost certainly forces re-auth) and conversation/message preservation for in-flight assignments.

**Key design questions:**
1. Cutover window — overnight, or schedule between quarters?
2. User identity bridge — can existing Django passwords be migrated to WorkOS, or do all users go through a "set a new password" flow?
3. Backfill `Conversation.id` UUIDs as-is, or regenerate?
4. Per-token AI message rows are large; archive or import in full?

**Estimated effort:** 3–4 days plus a dry run on a staging copy.

---

## Phase 11: Cutover + Django Retirement

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Point `llteacher.coolify.redbeardlab.com` (or its replacement) at the Cloudflare Worker. Archive the Django code (move `apps/`, `src/`, `services/` to `legacy_django/`). Stop the Coolify deployment. Update root README.

**Estimated effort:** 2 days.

---

## Self-Review Notes

**Spec coverage:** All current Django subsystems (accounts, homeworks, conversations, llm, permissions, admin, seed data, R execution, streaming) map to phases 1–11. Phase 0 covers nothing functional except scaffolding — that's intentional and called out.

**Placeholder scan:** Phase 0 contains no placeholders — every step has explicit file content, an exact command, or a concrete verification check. Phases 1–11 contain scope-level descriptions and design questions, **clearly labeled `STATUS: SCOPE ONLY`** with explicit instructions to re-plan via `/superpowers:writing-plans` before execution.

**Type consistency:** `Env`, `HelloResponse`, `Db` are defined once and referenced consistently. The `crypto.randomUUID()` call in Task 0.4 produces a string; the `pings.id` Drizzle column is `uuid` and `.returning()` returns it as a string in `neon-http` mode. The mock in Task 0.8 returns the same shape.

**Commit policy compliance:** Every "Stage and report" step instructs the executor to stage files and let the user invoke `/commit` rather than calling `git commit` directly. No Co-Authored-By trailers anywhere.

---

## Execution Handoff (Phase 0 only)

Phase 0 is execution-ready for `superpowers:subagent-driven-development`. Phases 1–11 each require their own dedicated `/superpowers:writing-plans` run against the design questions listed in each phase before any code is written.
